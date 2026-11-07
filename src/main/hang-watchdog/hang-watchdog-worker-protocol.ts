export const HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS = 2_000
export const HANG_WATCHDOG_TIMEOUT_MS = 45_000
export const HANG_WATCHDOG_CHECK_INTERVAL_MS = 5_000
export const HANG_WATCHDOG_DEADLOCK_CONFIRM_DELAY_MS = 10_000

export type HangWatchdogWorkerData = {
  parentPid: number
  markerPath: string
  timeoutMs: number
  checkIntervalMs: number
  /** Set only when a proven AppKit scene self-deadlock may be recovered by relaunching this bundle. */
  relaunchBundlePath: string | null
}

export type MainToHangWatchdogWorkerMessage = { type: 'heartbeat' } | { type: 'shutdown' }
