import type { RelayRegionDecision, RelayRegionWindow } from './relay-region-correction-protocol'
import {
  RELAY_REGIONS,
  regionMeasurement,
  type RegionMeasurement,
  type RelayRegionProbeReport
} from './relay-region-probe'

export async function measureRelayRegionDecision(
  window: RelayRegionWindow,
  options: {
    diagnosticOverride: boolean
    now: () => number
    measure: () => Promise<RelayRegionProbeReport[]>
  }
): Promise<RelayRegionDecision> {
  if (options.diagnosticOverride) {
    return { outcome: 'inconclusive', reason: 'diagnostic-override' }
  }
  if (window.expiresAt <= options.now()) {
    return { outcome: 'inconclusive', reason: 'expired-window' }
  }
  try {
    // Placement caches are never evidence for a new server-issued window.
    const reports = await options.measure()
    const measurements = reports
      .map(regionMeasurement)
      .filter((entry): entry is RegionMeasurement => entry !== null)
    const incumbent = measurements.find((entry) => entry.region === window.incumbentRegion)
    if (window.expiresAt <= options.now()) {
      return { outcome: 'inconclusive', reason: 'expired-window' }
    }
    if (!incumbent || measurements.length !== RELAY_REGIONS.length) {
      return { outcome: 'inconclusive', reason: 'incomplete-measurement' }
    }
    // A stable tie is conclusive evidence; the director applies the incumbent margin.
    return {
      outcome: 'conclusive',
      measurements: {
        'us-central1': measurements.find((entry) => entry.region === 'us-central1')!.latencyMs,
        'asia-east2': measurements.find((entry) => entry.region === 'asia-east2')!.latencyMs
      }
    }
  } catch {
    return { outcome: 'inconclusive', reason: 'catalog-unavailable' }
  }
}
