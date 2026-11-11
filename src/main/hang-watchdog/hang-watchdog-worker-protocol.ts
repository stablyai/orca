export const HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS = 2_000
export const HANG_WATCHDOG_TIMEOUT_MS = 45_000
export const HANG_WATCHDOG_CHECK_INTERVAL_MS = 5_000

export type HangWatchdogWorkerData = {
  parentPid: number
  markerPath: string
  timeoutMs: number
  checkIntervalMs: number
  tracePath?: string
}

export type MainToHangWatchdogWorkerMessage =
  | { type: 'heartbeat' }
  | { type: 'shutdown' }
  | { type: 'power-event'; event: HangPowerReceipt['event']; observedAt: number }
import type { HangPowerReceipt } from './hang-observations'
