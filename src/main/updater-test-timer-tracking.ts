import { vi } from 'vitest'

// resetModules leaves real timers armed; track global timer APIs, excluding timers/promises and promisify.

type RealTimerHandle = ReturnType<typeof setTimeout> | number
type ArmTimer = (...args: never[]) => RealTimerHandle
type ClearTimer = (handle?: RealTimerHandle) => void

type TimerGlobals = {
  setTimeout: ArmTimer
  setInterval: ArmTimer
  clearTimeout: ClearTimer
  clearInterval: ClearTimer
}

// DOM and Node timer overloads disagree; preserve their handles while tracking both shapes.
const timerGlobals = globalThis as unknown as TimerGlobals

const armedTimeouts = new Set<RealTimerHandle>()
const armedIntervals = new Set<RealTimerHandle>()
let originalTimers: TimerGlobals | null = null
let trackingTimers: TimerGlobals | null = null

const trackArmed = (arm: ArmTimer, armed: Set<RealTimerHandle>): ArmTimer =>
  Object.assign((...args: never[]) => {
    const handle = arm(...args)
    armed.add(handle)
    return handle
  }, arm)

// Untrack cancelled handles so recycled numeric ids cannot cancel unrelated timers.
const trackCleared = (clear: ClearTimer, armed: Set<RealTimerHandle>): ClearTimer =>
  Object.assign((handle?: RealTimerHandle) => {
    if (handle !== undefined) {
      armed.delete(handle)
    }
    clear(handle)
  }, clear)

export function trackRealTimers(): void {
  // Fake-clock restoration would discard our wrapper.
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
    // Restore only globals we still own; a fake clock may be installed over the wrapper.
    if (timerGlobals.setTimeout === tracking.setTimeout) {
      Object.assign(timerGlobals, original)
      originalTimers = null
      trackingTimers = null
    }
  }
}
