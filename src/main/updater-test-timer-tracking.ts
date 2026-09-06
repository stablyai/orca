import { vi } from 'vitest'

/**
 * Cancels the real timers an abandoned `updater` module instance left armed.
 *
 * Why: `vi.resetModules()` drops the previous test's instance but cannot cancel the timers it already
 * scheduled, so they fire into a later test and drive shared spies. Fake handles die with
 * `vi.useRealTimers()`, which leaves real handles as the only leak channel.
 *
 * Vitest arms its own test timeouts through `getSafeTimers()`, snapshotted at worker setup, so
 * nothing here can capture or cancel them.
 *
 * Scope: the `globalThis` timer functions only. `node:timers/promises` and `util.promisify`
 * bypass this entirely, so an `await setTimeout(...)` added to `updater.ts` would reopen the
 * leak without failing a test here.
 */

/** Node hands back a `Timeout` object; other environments hand back an id. */
type RealTimerHandle = ReturnType<typeof setTimeout> | number
type ArmTimer = (...args: never[]) => RealTimerHandle
type ClearTimer = (handle?: RealTimerHandle) => void

type TimerGlobals = {
  setTimeout: ArmTimer
  setInterval: ArmTimer
  clearTimeout: ClearTimer
  clearInterval: ClearTimer
}

// Why: the ambient `setTimeout` overloads disagree on the handle type across lib.dom/@types/node;
// this view keeps the wrapper honest about what it actually does — pass through and remember.
const timerGlobals = globalThis as unknown as TimerGlobals

const armedTimeouts = new Set<RealTimerHandle>()
const armedIntervals = new Set<RealTimerHandle>()
let originalTimers: TimerGlobals | null = null
let trackingTimers: TimerGlobals | null = null

/** Returns the handle untouched so callers keep `unref()` and friends. */
const trackArmed = (arm: ArmTimer, armed: Set<RealTimerHandle>): ArmTimer =>
  Object.assign((...args: never[]) => {
    const handle = arm(...args)
    armed.add(handle)
    return handle
  }, arm)

/** Untracking on cancel bounds the set and keeps a recycled numeric id from cancelling a live timer. */
const trackCleared = (clear: ClearTimer, armed: Set<RealTimerHandle>): ClearTimer =>
  Object.assign((handle?: RealTimerHandle) => {
    if (handle !== undefined) {
      armed.delete(handle)
    }
    clear(handle)
  }, clear)

/** Wraps the real timer globals so anything armed from here on can be cancelled. Idempotent. */
export function trackRealTimers(): void {
  // Why: wrapping a fake clock would capture handles vitest already discards, and its restore would
  // throw the wrapper away anyway.
  if (trackingTimers || vi.isFakeTimers()) {
    return
  }
  const original: TimerGlobals = {
    setTimeout: timerGlobals.setTimeout,
    setInterval: timerGlobals.setInterval,
    clearTimeout: timerGlobals.clearTimeout,
    clearInterval: timerGlobals.clearInterval
  }
  originalTimers = original
  trackingTimers = {
    setTimeout: trackArmed(original.setTimeout, armedTimeouts),
    setInterval: trackArmed(original.setInterval, armedIntervals),
    clearTimeout: trackCleared(original.clearTimeout, armedTimeouts),
    clearInterval: trackCleared(original.clearInterval, armedIntervals)
  }
  Object.assign(timerGlobals, trackingTimers)
}

/** Cancels every real timer armed since tracking started, then hands the globals back untouched. */
export function clearTrackedRealTimers(): void {
  const original = originalTimers
  const tracking = trackingTimers
  if (!original || !tracking) {
    return
  }
  try {
    for (const handle of armedTimeouts) {
      original.clearTimeout(handle)
    }
    for (const handle of armedIntervals) {
      original.clearInterval(handle)
    }
  } finally {
    armedTimeouts.clear()
    armedIntervals.clear()
    // Why: a fake clock installed over the wrapper owns the globals until vitest restores it, so only
    // take back what is still ours; tracking stays on until then rather than clobbering the fakes.
    if (timerGlobals.setTimeout === tracking.setTimeout) {
      Object.assign(timerGlobals, original)
      originalTimers = null
      trackingTimers = null
    }
  }
}
