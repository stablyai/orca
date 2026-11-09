import { performance } from 'node:perf_hooks'
import { subscribeSystemPowerLifecycle } from './system-power-lifecycle'

/** A wall clock outrunning the monotonic clock by this much between samples means the machine
 *  slept without a power event (the monotonic clock stops while macOS and Linux sleep). */
const SLEEP_GAP_MS = 10_000

/** Monotonic time still marked suspended after which a resume event was evidently lost. Dark wakes
 *  run for seconds, so this never ends a real suspension early. */
const LOST_RESUME_MS = 2 * 60_000

export type AwakeClockSources = {
  wallNow: () => number
  monotonicNow: () => number
}

export type AwakeClock = {
  /** Wall-clock milliseconds minus every interval the system spent suspended; it stands still
   *  while suspended. With no power events it equals the wall clock. */
  now(): number
  /** Not suspended, and awake for at least `settleMs` since the last wake. */
  settled(settleMs: number): boolean
  suspend(): void
  resume(): void
}

const SYSTEM_SOURCES: AwakeClockSources = {
  // Read through the global each time so test fake timers apply.
  wallNow: () => Date.now(),
  monotonicNow: () => performance.now()
}

/** Why: a wall-clock deadline expires the moment a laptop wakes from a sleep that outlasted it,
 *  so anything that times out an active process must not count the time the machine slept. */
export function createAwakeClock(sources: AwakeClockSources = SYSTEM_SOURCES): AwakeClock {
  const { wallNow, monotonicNow } = sources
  let slept = 0
  let suspendedAt: { wall: number; monotonic: number } | null = null
  let lastWakeAt: number | null = null
  let gapSample = { wall: wallNow(), monotonic: monotonicNow() }

  const now = (): number => {
    if (suspendedAt && monotonicNow() - suspendedAt.monotonic >= LOST_RESUME_MS) {
      // The process has run for minutes while marked suspended: treat it as the missing resume.
      clock.resume()
    }
    return (suspendedAt ? suspendedAt.wall : wallNow()) - slept
  }

  const clock: AwakeClock = {
    now,
    settled(settleMs) {
      const wall = wallNow()
      const monotonic = monotonicNow()
      const sleptUnseen = wall - gapSample.wall - (monotonic - gapSample.monotonic) > SLEEP_GAP_MS
      gapSample = { wall, monotonic }
      const current = now()
      if (sleptUnseen && !suspendedAt) {
        lastWakeAt = current
      }
      return !suspendedAt && (lastWakeAt === null || current - lastWakeAt >= settleMs)
    },
    suspend() {
      // Dark wake can re-suspend without a resume; keep the earliest stamp.
      suspendedAt ??= { wall: wallNow(), monotonic: monotonicNow() }
    },
    resume() {
      if (!suspendedAt) {
        return
      }
      const wall = wallNow()
      slept += Math.max(0, wall - suspendedAt.wall)
      suspendedAt = null
      gapSample = { wall, monotonic: monotonicNow() }
      lastWakeAt = wall - slept
    }
  }
  return clock
}

let systemAwakeClock: AwakeClock | null = null

/** The process-wide awake clock, driven by the system's suspend and resume events. */
export function getSystemAwakeClock(): AwakeClock {
  if (!systemAwakeClock) {
    const clock = createAwakeClock()
    systemAwakeClock = clock
    // Lives for the process; subscribing replays the current state, which is harmless here.
    subscribeSystemPowerLifecycle({
      onSuspend: () => clock.suspend(),
      onResume: () => clock.resume()
    })
  }
  return systemAwakeClock
}

/** The awake clock's reading; a drop-in for `Date.now` in startup deadlines. */
export function awakeNow(): number {
  return getSystemAwakeClock().now()
}
