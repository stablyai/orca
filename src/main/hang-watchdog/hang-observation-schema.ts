export const SNAPSHOT_FIELDS = [
  'wallMs',
  'monotonicMs',
  'uptimeSeconds',
  'processUserUs',
  'processSystemUs',
  'watchdogUserUs',
  'watchdogSystemUs'
] as const
export type HangSnapshot = Record<(typeof SNAPSHOT_FIELDS)[number], number | null>

export const MACHINE_FIELDS = [
  'startedAt',
  'completedAt',
  'systemMemoryTotalMB',
  'systemMemoryFreeMB',
  'systemMemorySwapTotalMB',
  'systemMemorySwapUsedMB',
  'systemMemoryCompressorMB',
  'systemMemoryPressureLevel',
  'systemMemoryStatusLevel',
  'load1',
  'load5',
  'load15'
] as const
export type HangMachineSnapshot = Record<(typeof MACHINE_FIELDS)[number], number | null>
export type HangPowerReceipt = {
  event: 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'
  observedAt: number
  receivedAt: number
}
export type CompletedHangContext = { name: string; startedAt: number; completedAt: number }
/** What a worker last posted to its parent; a stuck receive names its sender here. */
export type HangWorkerSend = {
  role: string
  kind: string
  items: number
  bytes: number
  depth: number
  agoMs: number
  heapUsedMB: number
}
export const MAX_HANG_WORKER_SENDS = 4
export type HangObservation = {
  id: string
  kind: 'heartbeat-stall' | 'watchdog-gap'
  detectedAt: number
  parentPid: number
  durationMs: number
  selfRecovered: boolean
  initialSleepAssociated: boolean
  snapshot: HangSnapshot | null
  resolution: HangSnapshot | null
  machine: HangMachineSnapshot | null
  completedSpans: CompletedHangContext[] | null
  powerEvents: HangPowerReceipt[]
  mainJs?: MainJsCapture
  native?: NativeHangCapture
  watchdogGap?: { observedAt: number; durationMs: number; snapshot: HangSnapshot | null }
  workerSends?: HangWorkerSend[]
  /** Heartbeat stalls only; absent on records written before the stall tier existed, which were all hangs. */
  tier?: 'stall' | 'hang'
  /** When a stall-tier record crossed the hang timeout; durationMs keeps the stall-detection age. */
  escalatedAt?: number
  /** The version that observed it; the next launch may run another one. */
  appVersion?: string
  /** Last watchdog tick while this stall was live; stopping before escalation means the watchdog was blocked too. */
  watchdogTickAt?: number
}
/** Pre-tier records are hangs: the watchdog used to observe nothing shorter than its timeout. */
export function isHangTierObservation(record: HangObservation): boolean {
  return record.kind === 'heartbeat-stall' && record.tier !== 'stall'
}
/** Silence at detection plus the time after it: to recovery, or at least to escalation when main never answered. */
export function hangObservationUnresponsiveMs(record: HangObservation): number {
  // An escalated hang lasted at least to escalation, even if its resolution was stamped earlier.
  const lastKnownAt = Math.max(
    record.resolution?.wallMs ?? record.detectedAt,
    record.escalatedAt ?? record.detectedAt,
    // Each tick saw main still silent, so a run killed mid-stall was unresponsive at least that long.
    record.watchdogTickAt ?? record.detectedAt
  )
  return record.durationMs + Math.max(0, lastKnownAt - record.detectedAt)
}
/** Tier plus the build and last watchdog tick a stall record carries. */
export function parseHangStallTrailFields(
  data: Record<string, unknown>
): Pick<HangObservation, 'tier' | 'escalatedAt' | 'appVersion' | 'watchdogTickAt'> {
  const { appVersion, watchdogTickAt } = data
  return {
    ...parseHangTierFields(data),
    ...(typeof appVersion === 'string' && appVersion.length <= 64 ? { appVersion } : {}),
    ...(typeof watchdogTickAt === 'number' && Number.isFinite(watchdogTickAt)
      ? { watchdogTickAt }
      : {})
  }
}
type HangTierFields = Pick<HangObservation, 'tier' | 'escalatedAt'>
export function parseHangTierFields(data: Record<string, unknown>): HangTierFields {
  const escalatedAt = data.escalatedAt
  return {
    ...(data.kind === 'heartbeat-stall' && (data.tier === 'stall' || data.tier === 'hang')
      ? { tier: data.tier }
      : {}),
    ...(typeof escalatedAt === 'number' && Number.isFinite(escalatedAt) && escalatedAt >= 0
      ? { escalatedAt }
      : {})
  }
}
/** A stall escalates to a hang; a later stall-tier write never demotes it. */
export function mergeHangTierFields(old: HangTierFields, next: HangTierFields): HangTierFields {
  const tier = old.tier === 'hang' || next.tier === 'hang' ? 'hang' : (old.tier ?? next.tier)
  const escalatedAt = old.escalatedAt ?? next.escalatedAt
  return { ...(tier ? { tier } : {}), ...(escalatedAt !== undefined ? { escalatedAt } : {}) }
}
export type HangObservationCollection = {
  version: 1
  observations: HangObservation[]
  omitted: number
}
export type HangDetectionMarker = {
  detectedAt: number
  parentPid: number
  unresponsiveMs: number
  selfRecovered: boolean
  appVersion?: string
}
export function latestHangMarker(
  collection: HangObservationCollection
): HangDetectionMarker | null {
  // Short stalls are breadcrumbs only; the hang marker (and its telemetry) keeps meaning >= timeout.
  const record = collection.observations.findLast(isHangTierObservation)
  return record
    ? {
        detectedAt: record.detectedAt,
        parentPid: record.parentPid,
        unresponsiveMs: hangObservationUnresponsiveMs(record),
        selfRecovered: record.selfRecovered,
        ...(record.appVersion ? { appVersion: record.appVersion } : {})
      }
    : null
}
import type { MainJsCapture, NativeHangCapture } from './hang-stacks'
