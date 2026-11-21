import {
  hangObservationUnresponsiveMs,
  isHangTierObservation,
  type HangObservation,
  type HangPowerReceipt
} from './hang-observation-schema'
import type { HangWatchdogToMainMessage } from './hang-watchdog-worker-protocol'

/** A stall profiles JS only; the native sample waits until the same episode reaches the hang timeout. */
export const JS_ONLY = { js: true, native: false }
const NATIVE_ONLY = { js: false, native: true }
const BOTH = { js: true, native: true }

export type ObserveOptions = {
  tier?: HangObservation['tier']
  capture?: { js: boolean; native: boolean }
  /** Heartbeats already resumed; no resolution snapshot, since detection is the recovery. */
  recovered?: boolean
}

/** Past the hang timeout an episode is a hang however it was observed; the loop's `>` can let one recover as a stall. */
export function tierForSilence(unresponsiveMs: number, timeoutMs: number): 'stall' | 'hang' {
  return unresponsiveMs > timeoutMs ? 'hang' : 'stall'
}

/** Tier from the duration that will be reported, so the two agree; a 'stall' never demotes an escalated hang. */
export function recoveredTier(
  stall: HangObservation | undefined,
  resolution: HangObservation['resolution'],
  unresponsiveMs: number,
  timeoutMs: number
): 'stall' | 'hang' {
  return tierForSilence(
    stall ? hangObservationUnresponsiveMs({ ...stall, resolution }) : unresponsiveMs,
    timeoutMs
  )
}

/** escalatedAt keeps the loop-measured silence even when the stall's detectedAt was stamped late. */
export function escalationFields(
  stall: HangObservation,
  unresponsiveMs: number
): Pick<HangObservation, 'tier' | 'escalatedAt'> {
  return {
    tier: 'hang',
    escalatedAt: stall.detectedAt + Math.max(0, unresponsiveMs - stall.durationMs)
  }
}

/** A stall profile that never captured stacks gets the hang's fresh JS attempt. */
export function escalationCaptureParts(stall: HangObservation): { js: boolean; native: boolean } {
  return stall.mainJs?.stacks.length ? NATIVE_ONLY : BOTH
}

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
