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
  | { type: 'capture-drain-ack'; token: string }
  | { type: 'power-event'; event: HangPowerReceipt['event']; observedAt: number }
import type { HangPowerReceipt } from './hang-observations'

export type HangWatchdogToMainMessage = { type: 'capture-drain'; token: string }

export function isHangWatchdogWorkerData(value: unknown): value is HangWatchdogWorkerData {
  const data = value as Partial<HangWatchdogWorkerData> | null
  return (
    !!data &&
    Number.isInteger(data.parentPid) &&
    (data.parentPid ?? 0) > 0 &&
    typeof data.markerPath === 'string' &&
    (data.tracePath === undefined || typeof data.tracePath === 'string') &&
    Number.isFinite(data.timeoutMs) &&
    (data.timeoutMs ?? 0) > 0 &&
    Number.isFinite(data.checkIntervalMs) &&
    (data.checkIntervalMs ?? 0) > 0
  )
}
