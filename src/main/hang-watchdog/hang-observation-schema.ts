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
}
import type { MainJsCapture, NativeHangCapture } from './hang-stacks'
