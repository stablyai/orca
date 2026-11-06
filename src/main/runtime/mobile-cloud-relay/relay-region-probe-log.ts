import { relayDirectorHost } from './relay-region-catalog-fetch'
import type { RegionMeasurement, RelayRegion, RelayRegionProbeReport } from './relay-region-probe'

export const RELAY_REGION_PROBE_EVENT = 'relay_region_probe'
export const RELAY_REGION_SELF_HEAL_EVENT = 'relay_region_self_heal'

export type RelayRegionChoiceReason =
  | 'measured'
  | 'held-previous'
  | 'sole-survivor-forbidden'
  | 'all-unreachable'
  | 'all-rejected'
  | 'catalog-unavailable'
  | 'override'
  | 'cached'

export type RelayRegionProbeLogEvent = {
  event: typeof RELAY_REGION_PROBE_EVENT
  directorHost: string
  regions: RelayRegionProbeReport[]
  chosenRegion: RelayRegion | 'no-hint'
  reason: RelayRegionChoiceReason
  cached: boolean
  ttlMs: number
}

export type RelayRegionSelfHealDecision = 'kept' | 'deleted'

export type RelayRegionSelfHealLogEvent = {
  event: typeof RELAY_REGION_SELF_HEAL_EVENT
  directorHost: string
  cachedRegion: RelayRegion
  bestRegion: RelayRegion | null
  bestLatencyMs: number | null
  assignedCellUrl: string
  assignedLatencyMs: number | null
  decision: RelayRegionSelfHealDecision
  reason:
    | 'best-matches-cache'
    | 'no-region-measured'
    | 'catalog-unavailable'
    | 'assigned-cell-near'
    | 'assigned-cell-far'
}

export type RelayRegionLogEvent = RelayRegionProbeLogEvent | RelayRegionSelfHealLogEvent
export type RelayRegionLogSink = (event: RelayRegionLogEvent) => void

// JSON keeps nested support-log events on one searchable line.
export function logRelayRegionEvent(event: RelayRegionLogEvent): void {
  console.info('[relay-region]', JSON.stringify(event))
}

export function relayRegionCacheHitEvent(input: {
  directorUrl: string
  region: RelayRegion | null
  ttlMs: number
}): RelayRegionProbeLogEvent {
  return {
    event: RELAY_REGION_PROBE_EVENT,
    directorHost: relayDirectorHost(input.directorUrl),
    regions: [],
    chosenRegion: input.region ?? 'no-hint',
    reason: 'cached',
    cached: true,
    ttlMs: input.ttlMs
  }
}

export function relayRegionOverrideEvent(input: {
  directorUrl: string
  region: RelayRegion
}): RelayRegionProbeLogEvent {
  return {
    event: RELAY_REGION_PROBE_EVENT,
    directorHost: relayDirectorHost(input.directorUrl),
    regions: [],
    chosenRegion: input.region,
    reason: 'override',
    cached: false,
    ttlMs: 0
  }
}

export function relayRegionCatalogFailureEvent(directorUrl: string): RelayRegionProbeLogEvent {
  return {
    event: RELAY_REGION_PROBE_EVENT,
    directorHost: relayDirectorHost(directorUrl),
    regions: [],
    chosenRegion: 'no-hint',
    reason: 'catalog-unavailable',
    cached: false,
    ttlMs: 0
  }
}

export function relayRegionRefreshEvent(input: {
  directorUrl: string
  reports: RelayRegionProbeReport[]
  best: RegionMeasurement | null
  selected: RegionMeasurement | null
  ttlMs: number
}): RelayRegionProbeLogEvent {
  return {
    event: RELAY_REGION_PROBE_EVENT,
    directorHost: relayDirectorHost(input.directorUrl),
    regions: input.reports,
    chosenRegion: input.selected?.region ?? 'no-hint',
    reason: refreshReason(input.reports, input.best, input.selected),
    cached: false,
    ttlMs: input.ttlMs
  }
}

function refreshReason(
  reports: RelayRegionProbeReport[],
  best: RegionMeasurement | null,
  selected: RegionMeasurement | null
): RelayRegionChoiceReason {
  if (selected) {
    return best && selected.region !== best.region ? 'held-previous' : 'measured'
  }
  if (reports.some((report) => report.verdict === 'measured')) {
    return 'sole-survivor-forbidden'
  }
  return reports.every((report) => report.verdict === 'unreachable')
    ? 'all-unreachable'
    : 'all-rejected'
}
