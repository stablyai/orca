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
