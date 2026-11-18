import {
  isHangTierObservation,
  type HangObservation,
  type HangPowerReceipt
} from './hang-observation-schema'
import type { HangWatchdogToMainMessage } from './hang-watchdog-worker-protocol'

/** A stall profiles JS only; the native sample waits until the same episode reaches the hang timeout. */
export const JS_ONLY = { js: true, native: false }
export const NATIVE_ONLY = { js: false, native: true }

/** A suspend inside the silence means the machine slept, not that main stalled. */
export function suspendedSince(power: readonly HangPowerReceipt[], startedAt: number): boolean {
  return power.some((item) => item.event === 'suspend' && item.observedAt >= startedAt)
}

export function stallRecoveredMessage(
  record: HangObservation | undefined,
  unresponsiveMs: number,
  endedAt: number
): HangWatchdogToMainMessage {
  return {
    type: 'stall-recovered',
    tier: record && isHangTierObservation(record) ? 'hang' : 'stall',
    unresponsiveMs,
    endedAt
  }
}
