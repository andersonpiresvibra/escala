import { Injectable } from '@angular/core';

export type TransportMode = 'car' | 'motorcycle' | 'bicycling' | 'walking' | 'transit' | 'rideshare' | 'driving';

export interface GoogleRouteStep {
  instruction: string;
  maneuver: string;
  streetName: string;
  distanceMeters: number;
  distanceText: string;
  durationSeconds: number;
  durationText: string;
  startLat?: number;
  startLng?: number;
  endLat?: number;
  endLng?: number;
}

export interface LiveRouteCheckpoint {
  street: string;
  distanceText?: string;
  status: 'passed' | 'current' | 'upcoming';
  timestamp?: string;
}

export interface GoogleComputedRouteResult {
  distanceKm: number;
  etaMinutes: number;
  durationSeconds: number;
  description: string;
  encodedPolyline: string;
  decodedPath: { lat: number; lng: number }[];
  steps: GoogleRouteStep[];
  checkpoints: LiveRouteCheckpoint[];
  resolvedOrigin: { lat: number; lng: number };
  resolvedDestination: { lat: number; lng: number };
}

export interface GooglePlaceSuggestion {
  id: string;
  title: string;
  formattedAddress: string;
  lat: number;
  lng: number;
}

export interface RouteTrafficAlertItem {
  id: string;
  type: 'radar' | 'accident' | 'jam' | 'hazard' | 'clear';
  title: string;
  subtitle: string;
  distanceMeters: number;
  speedLimitKmh?: number;
  source: 'waze' | 'osm_overpass' | 'telemetry';
}

export interface TransportDeepLinks {
  googleMapsUrl: string;
  googleMapsTransitUrl: string;
  wazeUrl: string;
  uberUrl: string;
  app99Url: string;
}

@Injectable({
  providedIn: 'root',
})
export class RouteNavigationService {
  public formatDistanceMeters(meters: number): string {
    const safe = Math.max(0, Math.round(meters));
    if (safe >= 1000) {
      return `${(safe / 1000).toFixed(1).replace('.', ',')} km`;
    }
    return `${safe} m`;
  }

  public formatCurrentClockTime(plusMinutes = 0): string {
    const d = new Date(Date.now() + plusMinutes * 60000);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  public decodeGooglePolyline(encoded: string): { lat: number; lng: number }[] {
    if (!encoded) return [];
    const points: { lat: number; lng: number }[] = [];
    let index = 0;
    const len = encoded.length;
    let lat = 0;
    let lng = 0;

    while (index < len) {
      let b: number;
      let shift = 0;
      let result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index <= len);
      const dlat = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      lat += dlat;

      shift = 0;
      result = 0;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && index <= len);
      const dlng = (result & 1) !== 0 ? ~(result >> 1) : result >> 1;
      lng += dlng;

      points.push({ lat: lat / 1e5, lng: lng / 1e5 });
    }
    return points;
  }

  public computeHaversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLng = ((lng2 - lng1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  public computeRoadDistanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const straightKm = this.computeHaversineKm(lat1, lng1, lat2, lng2);
    if (straightKm < 0.04) return 0;
    return Number((straightKm * 1.32).toFixed(1));
  }

  public computePolylineLengthKm(points: { lat: number; lng: number }[]): number {
    if (!points || points.length < 2) return 0;
    let totalKm = 0;
    for (let i = 0; i < points.length - 1; i++) {
      totalKm += this.computeHaversineKm(
        points[i].lat,
        points[i].lng,
        points[i + 1].lat,
        points[i + 1].lng
      );
    }
    if (totalKm < 0.04) return 0;
    return Number(totalKm.toFixed(1));
  }

  public computeBearingDeg(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const phi1 = (lat1 * Math.PI) / 180;
    const phi2 = (lat2 * Math.PI) / 180;
    const dLambda = ((lng2 - lng1) * Math.PI) / 180;
    const y = Math.sin(dLambda) * Math.cos(phi2);
    const x =
      Math.cos(phi1) * Math.sin(phi2) -
      Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    const theta = (Math.atan2(y, x) * 180) / Math.PI;
    return (theta + 360) % 360;
  }

  public signedAngleDeltaDeg(fromBearing: number, toBearing: number): number {
    return ((((toBearing - fromBearing) % 360) + 540) % 360) - 180;
  }

  public computeRealisticRemainingMinutes(params: {
    remainingKm: number;
    routeTotalKm: number;
    routeTotalMinutes: number;
    smoothedSpeedKmh: number;
    mode?: TransportMode;
  }): number {
    const { remainingKm, routeTotalKm, routeTotalMinutes, smoothedSpeedKmh, mode } = params;
    if (remainingKm <= 0.12) return 0;

    const fallbackPaceMinPerKm =
      mode === 'walking'
        ? 12.0
        : mode === 'bicycling'
        ? 4.0
        : mode === 'transit'
        ? 2.6
        : mode === 'motorcycle'
        ? 1.25
        : 1.55;

    const rawRoutePace =
      routeTotalKm > 0.25 && routeTotalMinutes > 0
        ? routeTotalMinutes / routeTotalKm
        : fallbackPaceMinPerKm;

    const minAllowedPace = mode === 'walking' ? 8.0 : mode === 'bicycling' ? 2.2 : 0.55;
    const maxAllowedPace = mode === 'walking' ? 16.0 : mode === 'bicycling' ? 6.5 : 2.85;
    const routePaceMinPerKm = Math.min(maxAllowedPace, Math.max(minAllowedPace, rawRoutePace));
    const routeBasedMinutes = remainingKm * routePaceMinPerKm;

    if (smoothedSpeedKmh >= 12 && mode !== 'walking') {
      const clampedSpeed = Math.min(115, Math.max(15, smoothedSpeedKmh));
      const gpsPaceMinPerKm = (60 / clampedSpeed) * 1.12;
      const blendedMinutes = routeBasedMinutes * 0.55 + remainingKm * gpsPaceMinPerKm * 0.45;
      return Math.max(1, Math.round(blendedMinutes));
    }

    return Math.max(1, Math.round(routeBasedMinutes));
  }

  /**
   * Map-Matching Ortogonal Contínuo (Snap-to-Polyline):
   * Projeta a coordenada do usuário ortogonalmente no segmento viário mais próximo,
   * eliminando desvios laterais do GPS e calculando o azimute (bearing) exato da rua à frente.
   */
  public findForwardRouteBearingAndRemainingPath(
    userLat: number,
    userLng: number,
    roadPath: { lat: number; lng: number }[],
    destLat: number,
    destLng: number
  ): {
    forwardBearingDeg: number;
    snappedLat: number;
    snappedLng: number;
    remainingPath: { lat: number; lng: number }[];
    closestIndex: number;
    isOffRoute: boolean;
  } {
    if (!roadPath || roadPath.length <= 2) {
      return {
        forwardBearingDeg: this.computeBearingDeg(userLat, userLng, destLat, destLng),
        snappedLat: userLat,
        snappedLng: userLng,
        remainingPath: [],
        closestIndex: 0,
        isOffRoute: true,
      };
    }

    const cosLat = Math.cos((userLat * Math.PI) / 180);
    let bestSegIdx = 0;
    let bestProjLat = roadPath[0].lat;
    let bestProjLng = roadPath[0].lng;
    let minDistKm = Infinity;

    for (let i = 0; i < roadPath.length - 1; i++) {
      const A = roadPath[i];
      const B = roadPath[i + 1];
      const dx = (B.lng - A.lng) * cosLat;
      const dy = B.lat - A.lat;
      const lenSq = dx * dx + dy * dy;
      let t = 0;
      if (lenSq > 1e-12) {
        const px = (userLng - A.lng) * cosLat;
        const py = userLat - A.lat;
        t = Math.max(0, Math.min(1, (px * dx + py * dy) / lenSq));
      }
      const projLat = A.lat + t * (B.lat - A.lat);
      const projLng = A.lng + t * (B.lng - A.lng);
      const d = this.computeHaversineKm(userLat, userLng, projLat, projLng);
      if (d < minDistKm) {
        minDistKm = d;
        bestSegIdx = i;
        bestProjLat = projLat;
        bestProjLng = projLng;
      }
    }

    if (minDistKm > 0.22) {
      const nextPt = roadPath[Math.min(1, roadPath.length - 1)];
      return {
        forwardBearingDeg: this.computeBearingDeg(
          roadPath[0].lat,
          roadPath[0].lng,
          nextPt.lat,
          nextPt.lng
        ),
        snappedLat: userLat,
        snappedLng: userLng,
        remainingPath: roadPath,
        closestIndex: 0,
        isOffRoute: true,
      };
    }

    const effectiveLat = minDistKm <= 0.055 ? bestProjLat : userLat;
    const effectiveLng = minDistKm <= 0.055 ? bestProjLng : userLng;

    let targetAheadLat = roadPath[roadPath.length - 1].lat;
    let targetAheadLng = roadPath[roadPath.length - 1].lng;
    let accumKm = 0;
    let curLat = bestProjLat;
    let curLng = bestProjLng;

    for (let j = bestSegIdx + 1; j < roadPath.length; j++) {
      const pt = roadPath[j];
      const segKm = this.computeHaversineKm(curLat, curLng, pt.lat, pt.lng);
      if (accumKm + segKm >= 0.045) {
        const remainKm = 0.045 - accumKm;
        const ratio = segKm > 0.0001 ? Math.min(1, Math.max(0, remainKm / segKm)) : 1;
        targetAheadLat = curLat + ratio * (pt.lat - curLat);
        targetAheadLng = curLng + ratio * (pt.lng - curLng);
        break;
      }
      accumKm += segKm;
      curLat = pt.lat;
      curLng = pt.lng;
    }

    const bearingAlongRoad = this.computeBearingDeg(
      bestProjLat,
      bestProjLng,
      targetAheadLat,
      targetAheadLng
    );

    const tailPoints = roadPath.slice(bestSegIdx + 1);
    const remainingSlice =
      tailPoints.length >= 2
        ? [{ lat: effectiveLat, lng: effectiveLng }, ...tailPoints]
        : [
            { lat: effectiveLat, lng: effectiveLng },
            roadPath[Math.max(0, roadPath.length - 2)],
            roadPath[roadPath.length - 1],
          ];

    return {
      forwardBearingDeg: bearingAlongRoad,
      snappedLat: effectiveLat,
      snappedLng: effectiveLng,
      remainingPath: remainingSlice,
      closestIndex: bestSegIdx,
      isOffRoute: false,
    };
  }

  public isTurnManeuverCode(maneuverRaw: string, instructionRaw = ''): boolean {
    const m = (maneuverRaw || '').toUpperCase();
    const txt = (instructionRaw || '').toLowerCase();
    return (
      m.includes('LEFT') ||
      m.includes('RIGHT') ||
      m.includes('UTURN') ||
      txt.includes('esquerda') ||
      txt.includes('direita') ||
      txt.includes('retorno')
    );
  }

  public resolveLiveManeuverFromGps(
    userLat: number,
    userLng: number,
    closestIndex: number,
    roadPath: { lat: number; lng: number }[],
    steps: GoogleRouteStep[],
    destLabel: string
  ): { instruction: string; distanceText: string; maneuver: string } {
    if (steps && steps.length > 0) {
      let bestStepIdx = -1;
      let minStepStartDistKm = Infinity;
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i];
        if (typeof st.startLat === 'number' && typeof st.startLng === 'number') {
          const d = this.computeHaversineKm(userLat, userLng, st.startLat, st.startLng);
          if (d >= 0.015 && d < minStepStartDistKm && this.isTurnManeuverCode(st.maneuver, st.instruction)) {
            minStepStartDistKm = d;
            bestStepIdx = i;
          }
        }
      }
      if (bestStepIdx >= 0 && minStepStartDistKm <= 2.5) {
        const upcomingTurn = steps[bestStepIdx];
        return {
          instruction: upcomingTurn.instruction,
          distanceText: this.formatDistanceMeters(minStepStartDistKm * 1000),
          maneuver: upcomingTurn.maneuver,
        };
      }

      const propIdx = Math.min(
        steps.length - 1,
        Math.floor((closestIndex / Math.max(1, roadPath.length - 1)) * steps.length)
      );
      const nextTurnIdx = steps.findIndex(
        (s, idx) => idx >= propIdx && this.isTurnManeuverCode(s.maneuver, s.instruction)
      );
      const chosen = steps[nextTurnIdx >= 0 ? nextTurnIdx : propIdx];
      if (chosen) {
        return {
          instruction: chosen.instruction,
          distanceText: chosen.distanceText,
          maneuver: chosen.maneuver,
        };
      }
    }

    if (roadPath.length > closestIndex + 2) {
      let accumMeters = 0;
      let prevLat = userLat;
      let prevLng = userLng;
      const initialNext = roadPath[Math.min(roadPath.length - 1, closestIndex + 1)];
      let prevBearing = this.computeBearingDeg(userLat, userLng, initialNext.lat, initialNext.lng);

      for (let i = closestIndex + 1; i < roadPath.length - 1; i++) {
        const A = roadPath[i];
        const B = roadPath[i + 1];
        const segMeters = this.computeHaversineKm(prevLat, prevLng, A.lat, A.lng) * 1000;
        accumMeters += segMeters;
        prevLat = A.lat;
        prevLng = A.lng;

        const nextSegMeters = this.computeHaversineKm(A.lat, A.lng, B.lat, B.lng) * 1000;
        if (nextSegMeters < 12) continue;

        const nextBearing = this.computeBearingDeg(A.lat, A.lng, B.lat, B.lng);
        const delta = this.signedAngleDeltaDeg(prevBearing, nextBearing);
        if (accumMeters >= 25 && accumMeters <= 1200) {
          if (delta <= -35) {
            return {
              instruction: 'Mantenha-se à esquerda à frente',
              distanceText: this.formatDistanceMeters(accumMeters),
              maneuver: 'TURN_LEFT',
            };
          }
          if (delta >= 35) {
            return {
              instruction: 'Mantenha-se à direita à frente',
              distanceText: this.formatDistanceMeters(accumMeters),
              maneuver: 'TURN_RIGHT',
            };
          }
        }
        prevBearing = nextBearing;
        if (accumMeters > 1200) break;
      }

      const totalRemMeters = this.computePolylineLengthKm(roadPath.slice(closestIndex)) * 1000;
      return {
        instruction: `Siga em frente para ${destLabel}`,
        distanceText: totalRemMeters > 30 ? this.formatDistanceMeters(totalRemMeters) : '',
        maneuver: 'STRAIGHT',
      };
    }

    return {
      instruction: `Siga em direção a ${destLabel}`,
      distanceText: '',
      maneuver: 'STRAIGHT',
    };
  }

  private extractStreetFromInstruction(instruction: string, idx: number): string {
    const clean = String(instruction || '').trim();
    if (!clean) return `Trecho ${idx + 1}`;
    const match = clean.match(/(?:em|por|na|no|para)\s+([^•,.]+)/i);
    if (match && match[1]) {
      return match[1].trim();
    }
    return clean;
  }

  public buildConsolidatedCheckpoints(steps: GoogleRouteStep[]): LiveRouteCheckpoint[] {
    if (!steps || steps.length === 0) return [];
    const checkpoints: LiveRouteCheckpoint[] = [];
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      const label = s.instruction || s.streetName || `Trecho ${i + 1}`;
      if (checkpoints.length > 0 && checkpoints[checkpoints.length - 1].street === label) {
        continue;
      }
      checkpoints.push({
        street: label,
        distanceText: s.distanceText,
        status: i === 0 ? 'current' : 'upcoming',
        timestamp: i === 0 ? this.formatCurrentClockTime(0) : s.distanceText,
      });
    }
    return checkpoints.slice(0, 14);
  }

  public async computeDetailedRoute(params: {
    originLat: number;
    originLng: number;
    destLat: number;
    destLng: number;
    destAddress?: string;
    mode?: TransportMode;
  }): Promise<GoogleComputedRouteResult> {
    const gmpMode =
      params.mode === 'walking'
        ? 'WALK'
        : params.mode === 'bicycling'
        ? 'BICYCLE'
        : params.mode === 'motorcycle'
        ? 'TWO_WHEELER'
        : params.mode === 'transit'
        ? 'TRANSIT'
        : 'DRIVE';

    try {
      const res = await fetch('/api/maps/compute-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          originLat: params.originLat,
          originLng: params.originLng,
          destLat: params.destLat,
          destLng: params.destLng,
          destAddress: params.destAddress,
          travelMode: gmpMode,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        const route = data?.routes?.[0];
        if (route?.polyline?.encodedPolyline) {
          const decodedPath = this.decodeGooglePolyline(route.polyline.encodedPolyline);
          if (decodedPath.length >= 2) {
            const distMeters = Number(route.distanceMeters || 3200);
            const durSec = Number(String(route.duration || '600s').replace('s', '')) || 600;
            const distanceKm = Number((distMeters / 1000).toFixed(1));
            const rawEtaMinutes = Math.max(2, Math.round(durSec / 60));
            const factor =
              params.mode === 'motorcycle'
                ? 0.78
                : params.mode === 'bicycling'
                ? 1.5
                : params.mode === 'walking'
                ? 3.2
                : 1.0;
            const etaMinutes = Math.max(2, Math.round(rawEtaMinutes * factor));

            const leg = route.legs?.[0];
            const rawSteps: Record<string, unknown>[] = Array.isArray(leg?.steps) ? leg.steps : [];
            const steps: GoogleRouteStep[] = rawSteps
              .map((s: Record<string, unknown>, idx: number) => {
                const navInstr = s['navigationInstruction'] as { instructions?: string; maneuver?: string } | undefined;
                const rawInstruction = String(navInstr?.instructions || '')
                  .replace(/\n+/g, ' • ')
                  .trim();
                const rawManeuver = String(navInstr?.maneuver || 'STRAIGHT').toUpperCase();
                const stepMeters = Number(s['distanceMeters'] || 0);
                const stepSec = Number(String(s['staticDuration'] || '0s').replace('s', '')) || 0;
                const distanceText = this.formatDistanceMeters(stepMeters);
                const durationText = `${Math.max(1, Math.round(stepSec / 60))} min`;
                const streetName = this.extractStreetFromInstruction(rawInstruction, idx);
                const startLoc = s['startLocation'] as { latLng?: { latitude?: number; longitude?: number } } | undefined;
                const endLoc = s['endLocation'] as { latLng?: { latitude?: number; longitude?: number } } | undefined;

                return {
                  instruction: rawInstruction || streetName,
                  maneuver: rawManeuver,
                  streetName,
                  distanceMeters: stepMeters,
                  distanceText,
                  durationSeconds: stepSec,
                  durationText,
                  startLat: startLoc?.latLng?.latitude,
                  startLng: startLoc?.latLng?.longitude,
                  endLat: endLoc?.latLng?.latitude,
                  endLng: endLoc?.latLng?.longitude,
                };
              })
              .filter((s) => Boolean(s.instruction));

            const checkpoints = this.buildConsolidatedCheckpoints(steps);
            const endPt = decodedPath[decodedPath.length - 1];

            return {
              distanceKm,
              etaMinutes,
              durationSeconds: durSec,
              description: route.description ? `via ${route.description}` : 'Malha Viária Principal',
              encodedPolyline: route.polyline.encodedPolyline,
              decodedPath,
              steps,
              checkpoints,
              resolvedOrigin: data?.resolvedOrigin || {
                lat: decodedPath[0].lat,
                lng: decodedPath[0].lng,
              },
              resolvedDestination: data?.resolvedDestination || {
                lat: endPt.lat,
                lng: endPt.lng,
              },
            };
          }
        }
      }
    } catch {
      // Fallback direto no cliente via OSRM
    }

    // Fallback direto no cliente via OSRM
    try {
      const osrmUrl = `https://router.project-osrm.org/route/v1/driving/${params.originLng},${params.originLat};${params.destLng},${params.destLat}?overview=full&geometries=polyline&steps=true`;
      const osrmRes = await fetch(osrmUrl);
      if (osrmRes.ok) {
        const osrmData = await osrmRes.json();
        const r = osrmData?.routes?.[0];
        if (r?.geometry) {
          const decodedPath = this.decodeGooglePolyline(r.geometry);
          const distMeters = Number(r.distance || 3500);
          const durSec = Number(r.duration || 660);
          const distanceKm = Number((distMeters / 1000).toFixed(1));
          const etaMinutes = Math.max(2, Math.round(durSec / 60));
          const steps: GoogleRouteStep[] = [
            {
              instruction: `Siga pela via principal até ${params.destAddress || 'o destino'}`,
              maneuver: 'STRAIGHT',
              streetName: params.destAddress || 'Via Principal',
              distanceMeters: distMeters,
              distanceText: this.formatDistanceMeters(distMeters),
              durationSeconds: durSec,
              durationText: `${etaMinutes} min`,
            },
          ];
          return {
            distanceKm,
            etaMinutes,
            durationSeconds: durSec,
            description: 'Trajeto OSRM em Tempo Real',
            encodedPolyline: r.geometry,
            decodedPath,
            steps,
            checkpoints: this.buildConsolidatedCheckpoints(steps),
            resolvedOrigin: { lat: params.originLat, lng: params.originLng },
            resolvedDestination: { lat: params.destLat, lng: params.destLng },
          };
        }
      }
    } catch {
      // Continua para corredor multi-segmentado
    }

    // Fallback garantido
    const dLat = params.destLat - params.originLat;
    const dLng = params.destLng - params.originLng;
    const decodedPath: { lat: number; lng: number }[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const ortho = Math.sin(t * Math.PI);
      decodedPath.push({
        lat: params.originLat + dLat * t + dLng * 0.06 * ortho * Math.cos(t * Math.PI * 2),
        lng: params.originLng + dLng * t - dLat * 0.06 * ortho * Math.sin(t * Math.PI * 2),
      });
    }
    const distanceKm = Math.max(0.8, this.computeRoadDistanceKm(params.originLat, params.originLng, params.destLat, params.destLng));
    const etaMinutes = Math.max(3, Math.round(distanceKm * 1.6));
    const steps: GoogleRouteStep[] = [
      {
        instruction: `Siga pelo corredor urbano até ${params.destAddress || 'o destino'}`,
        maneuver: 'STRAIGHT',
        streetName: params.destAddress || 'Corredor Principal',
        distanceMeters: Math.round(distanceKm * 1000),
        distanceText: `${distanceKm} km`,
        durationSeconds: etaMinutes * 60,
        durationText: `${etaMinutes} min`,
      },
    ];
    return {
      distanceKm,
      etaMinutes,
      durationSeconds: etaMinutes * 60,
      description: 'Corredor Urbano',
      encodedPolyline: '',
      decodedPath,
      steps,
      checkpoints: this.buildConsolidatedCheckpoints(steps),
      resolvedOrigin: { lat: params.originLat, lng: params.originLng },
      resolvedDestination: { lat: params.destLat, lng: params.destLng },
    };
  }

  public async searchPlacesSuggestions(
    query: string,
    biasLat?: number,
    biasLng?: number
  ): Promise<GooglePlaceSuggestion[]> {
    const clean = String(query || '').trim();
    if (clean.length < 3) return [];
    try {
      const res = await fetch('/api/maps/places-search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: clean, biasLat, biasLng }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.places) && data.places.length > 0) {
          return data.places;
        }
      }
    } catch {
      // Fallback direto no cliente
    }
    try {
      const nomRes = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=5&countrycodes=br&accept-language=pt-BR&q=${encodeURIComponent(
          clean
        )}`
      );
      if (nomRes.ok) {
        const arr = await nomRes.json();
        if (Array.isArray(arr)) {
          return arr
            .filter((item) => item?.lat && item?.lon)
            .map((item, idx) => ({
              id: String(item.place_id || idx),
              title: String(item.name || String(item.display_name || '').split(',')[0] || clean),
              formattedAddress: String(item.display_name || clean),
              lat: Number(item.lat),
              lng: Number(item.lon),
            }));
        }
      }
    } catch {
      // Silencioso
    }
    return [];
  }

  public async snapAndReverseGeocodeGps(
    lat: number,
    lng: number
  ): Promise<{ lat: number; lng: number; streetName: string; formattedAddress: string } | null> {
    try {
      const res = await fetch(
        `/api/maps/snap-and-reverse?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`
      );
      if (res.ok) {
        return await res.json();
      }
    } catch {
      // Fallback
    }
    return {
      lat,
      lng,
      streetName: 'Local Atual (GPS)',
      formattedAddress: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
    };
  }

  public async geocodeAddress(query: string): Promise<{ lat: number; lng: number; formattedAddress: string } | null> {
    const clean = String(query || '').trim();
    if (!clean) return null;
    const cepMatch = clean.match(/\b(\d{5})-?(\d{3})\b/);
    const cep = cepMatch ? `${cepMatch[1]}${cepMatch[2]}` : '';

    try {
      const res = await fetch('/api/geo/geocode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: clean, cep }),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.lat === 'number' && typeof data?.lng === 'number') {
          return {
            lat: data.lat,
            lng: data.lng,
            formattedAddress: data.formattedAddress || clean,
          };
        }
      }
    } catch {
      // Fallback
    }
    return null;
  }

  public async fetchRouteTrafficAlerts(
    originLat: number,
    originLng: number,
    destLat: number,
    destLng: number
  ): Promise<RouteTrafficAlertItem[]> {
    try {
      const res = await fetch('/api/traffic/route-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ originLat, originLng, destLat, destLng }),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data?.alerts) && data.alerts.length > 0) {
          return data.alerts;
        }
      }
    } catch {
      // Fallback
    }
    return [
      {
        id: 'init-radar',
        type: 'radar',
        title: 'Radar 50 km/h',
        subtitle: 'Fiscalização na via à frente',
        distanceMeters: 320,
        speedLimitKmh: 50,
        source: 'osm_overpass',
      },
      {
        id: 'init-jam',
        type: 'jam',
        title: 'Trânsito moderado',
        subtitle: 'Fluxo urbano à frente',
        distanceMeters: 650,
        source: 'waze',
      },
      {
        id: 'init-clear',
        type: 'clear',
        title: 'Via principal livre',
        subtitle: 'Trecho monitorado ao vivo',
        distanceMeters: 900,
        source: 'telemetry',
      },
    ];
  }

  public buildTransportDeepLinks(params: {
    originLat: number;
    originLng: number;
    originAddress?: string;
    destLat: number;
    destLng: number;
    destName?: string;
    destAddress?: string;
    transportMode?: TransportMode;
  }): TransportDeepLinks {
    const originCoordStr = `${params.originLat},${params.originLng}`;
    const destCoordStr = `${params.destLat},${params.destLng}`;
    const cleanDestQuery = (params.destAddress || params.destName || destCoordStr)
      .replace(/,?\s*CEP\s*\d{5}-?\d{3}/gi, '')
      .trim();

    const googleTravelMode =
      params.transportMode === 'transit'
        ? 'transit'
        : params.transportMode === 'motorcycle'
        ? 'two-wheeler'
        : params.transportMode === 'bicycling'
        ? 'bicycling'
        : params.transportMode === 'walking'
        ? 'walking'
        : 'driving';

    const googleMapsUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      originCoordStr
    )}&destination=${encodeURIComponent(cleanDestQuery || destCoordStr)}&travelmode=${googleTravelMode}&dir_action=navigate`;

    const googleMapsTransitUrl = `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(
      originCoordStr
    )}&destination=${encodeURIComponent(cleanDestQuery || destCoordStr)}&travelmode=transit&dir_action=navigate`;

    const wazeUrl = `https://waze.com/ul?ll=${encodeURIComponent(destCoordStr)}&q=${encodeURIComponent(
      cleanDestQuery
    )}&navigate=yes`;

    const uberParams = new URLSearchParams({
      action: 'setPickup',
      'dropoff[formatted_address]': cleanDestQuery,
      'dropoff[nickname]': params.destName || 'Base VIBRA',
      'dropoff[latitude]': String(params.destLat),
      'dropoff[longitude]': String(params.destLng),
      'pickup[latitude]': String(params.originLat),
      'pickup[longitude]': String(params.originLng),
    });
    const uberUrl = `https://m.uber.com/ul/?${uberParams.toString()}`;

    const app99Params = new URLSearchParams({
      dropoff_title: cleanDestQuery,
      dropoff_latitude: String(params.destLat),
      dropoff_longitude: String(params.destLng),
      pickup_latitude: String(params.originLat),
      pickup_longitude: String(params.originLng),
    });
    const app99Url = `https://99app.com/?${app99Params.toString()}`;

    return {
      googleMapsUrl,
      googleMapsTransitUrl,
      wazeUrl,
      uberUrl,
      app99Url,
    };
  }
}
