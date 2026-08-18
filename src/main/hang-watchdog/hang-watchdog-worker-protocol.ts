export const HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS = 2_000
export const HANG_WATCHDOG_TIMEOUT_MS = 45_000
export const HANG_WATCHDOG_CHECK_INTERVAL_MS = 5_000

export type HangWatchdogWorkerData = {
  parentPid: number
  markerPath: string
  timeoutMs: number
  checkIntervalMs: number
}

export type MainToHangWatchdogWorkerMessage = { type: 'heartbeat' } | { type: 'shutdown' }
