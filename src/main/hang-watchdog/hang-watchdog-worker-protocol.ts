export const HANG_WATCHDOG_HEARTBEAT_INTERVAL_MS = 2_000
export const HANG_WATCHDOG_TIMEOUT_MS = 45_000
// Heartbeat age, so main itself was blocked for 6-8 s: a beachball that recovers long before the hang timeout.
export const HANG_WATCHDOG_STALL_MS = 8_000
export const HANG_WATCHDOG_CHECK_INTERVAL_MS = 5_000
import type { NativeHangProcessMetadata } from './native-hang-report'

export type HangWatchdogWorkerData = {
  parentPid: number
  markerPath: string
  timeoutMs: number
  checkIntervalMs: number
  stallMs?: number
  tracePath?: string
  artifactDirectory?: string
  processMetadata?: NativeHangProcessMetadata
}

export type MainToHangWatchdogWorkerMessage =
  | { type: 'heartbeat' }
  | { type: 'shutdown' }
  | { type: 'capture-drain-ack'; token: string }
  | { type: 'menu-bar-setting'; enabled: boolean }
  | { type: 'power-event'; event: HangPowerReceipt['event']; observedAt: number }
import type { HangPowerReceipt } from './hang-observations'

export type HangWatchdogToMainMessage =
  | { type: 'capture-drain'; token: string }
  | { type: 'stall-recovered'; tier: 'stall' | 'hang'; unresponsiveMs: number; endedAt: number }

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
    (data.checkIntervalMs ?? 0) > 0 &&
    (data.stallMs === undefined || (Number.isFinite(data.stallMs) && data.stallMs > 0))
  )
}
