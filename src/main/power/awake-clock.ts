import { subscribeSystemPowerLifecycle } from './system-power-lifecycle'

/** How often the clock samples itself while in use, so a stretch with no samples means the
 *  process was not running (system sleep, or an App Nap-sized stall). */
export const AWAKE_CLOCK_HEARTBEAT_MS = 20_000

/** A sample gap this long means the process did not run in between. Sleeps shorter than this go
 *  unnoticed without a power event. */
export const AWAKE_CLOCK_SLEEP_GAP_MS = 3 * AWAKE_CLOCK_HEARTBEAT_MS

/** The heartbeat stops after this long without a read. It outlasts the agent startup ceiling, and
 *  the automation scheduler reads every tick only while an automation is enabled. */
export const AWAKE_CLOCK_IDLE_MS = 15 * 60_000

/** Uninterrupted running while still marked suspended after which a resume event was evidently
 *  lost. Dark wakes run for seconds, so this never ends a real suspension early. */
const LOST_RESUME_MS = 2 * 60_000

export type AwakeClockSources = {
  wallNow: () => number
  /** Never runs backward or follows wall corrections. It may count sleep (macOS and Windows
   *  Node clocks do) or not (Linux CLOCK_MONOTONIC); the clock is correct either way. */
  monotonicNow: () => number
  /** Runs `beat` once after `ms`. Timers do not fire while the machine sleeps. */
  after: (beat: () => void, ms: number) => void
}

export type AwakeClock = {
  /** Milliseconds of awake time, anchored to the wall clock at creation: it stands still while
   *  suspended or in a stretch the process did not run, and ignores wall-clock corrections. */
  now(): number
  /** Not suspended, and awake for at least `settleMs` since the last wake. */
  settled(settleMs: number): boolean
  suspend(): void
  resume(): void
}

const SYSTEM_SOURCES: AwakeClockSources = {
  // Read through the globals each time so test fake timers apply.
  wallNow: () => Date.now(),
  monotonicNow: () => globalThis.performance.now(),
  after: (beat, ms) => {
    setTimeout(beat, ms).unref()
  }
}

/** Why: a wall-clock deadline expires the moment a laptop wakes from a sleep that outlasted it,
 *  so anything that times out an active process must not count the time the machine slept.
 *  Limit: reads more than AWAKE_CLOCK_IDLE_MS apart, with no power event, cannot tell a sleep
 *  between them from idle time on a counter that counts sleep. */
export function createAwakeClock(sources: AwakeClockSources = SYSTEM_SOURCES): AwakeClock {
  const { wallNow, monotonicNow } = sources
  const createdAt = { wall: wallNow(), monotonic: monotonicNow() }
  /** Monotonic time excluded from awake time. */
  let slept = 0
  let suspendedAt: number | null = null
  /** Monotonic start of the current stretch the process has run without a gap. */
  let runningSince = createdAt.monotonic
  /** Awake reading at the last wake; null until the machine is seen to wake. */
  let lastWakeAt: number | null = null
  let sample = { ...createdAt }
  let lastReadAt = createdAt.monotonic
  let beating = false

  const awake = (monotonic: number): number =>
    monotonic - createdAt.monotonic - slept - (suspendedAt === null ? 0 : monotonic - suspendedAt)

  const endSuspension = (resumedAt: number): void => {
    if (suspendedAt === null) {
      return
    }
    slept += Math.max(0, resumedAt - suspendedAt)
    suspendedAt = null
    lastWakeAt = awake(resumedAt)
  }

  /** Reads both clocks and records any stretch the process did not run as a wake. */
  const observe = (afterIdle: boolean): number => {
    const wall = wallNow()
    const monotonic = monotonicNow()
    const sinceMonotonic = monotonic - sample.monotonic
    // A counter that counts sleep shows the gap itself; one that excludes it shows only on the
    // wall. After an unsampled idle stretch, only the wall gap is evidence of sleep.
    const counterGap =
      !afterIdle && (sinceMonotonic < 0 || sinceMonotonic > AWAKE_CLOCK_SLEEP_GAP_MS)
    const wallGap = wall - sample.wall - sinceMonotonic > AWAKE_CLOCK_SLEEP_GAP_MS
    sample = { wall, monotonic }
    if (counterGap || wallGap) {
      runningSince = monotonic
      if (suspendedAt === null) {
        // A suspension's span is excluded on resume; outside one, exclude the gap now.
        slept += counterGap ? sinceMonotonic : 0
        lastWakeAt = awake(monotonic)
      }
    }
    if (suspendedAt !== null && monotonic - runningSince >= LOST_RESUME_MS) {
      endSuspension(Math.max(suspendedAt, runningSince))
    }
    return monotonic
  }

  const beat = (): void => {
    const monotonic = observe(false)
    beating = monotonic - lastReadAt < AWAKE_CLOCK_IDLE_MS
    if (beating) {
      sources.after(beat, AWAKE_CLOCK_HEARTBEAT_MS)
    }
  }

  const read = (): number => {
    const monotonic = observe(!beating)
    lastReadAt = monotonic
    if (!beating) {
      beating = true
      sources.after(beat, AWAKE_CLOCK_HEARTBEAT_MS)
    }
    return monotonic
  }

  return {
    now: () => createdAt.wall + awake(read()),
    settled(settleMs) {
      const monotonic = read()
      return (
        suspendedAt === null && (lastWakeAt === null || awake(monotonic) - lastWakeAt >= settleMs)
      )
    },
    suspend() {
      // Dark wake can re-suspend without a resume; keep the earliest stamp.
      const monotonic = read()
      if (suspendedAt === null) {
        suspendedAt = monotonic
        runningSince = monotonic
      }
    },
    resume() {
      const monotonic = read()
      runningSince = monotonic
      endSuspension(monotonic)
    }
  }
}

let systemAwakeClock: AwakeClock | null = null

/** The process-wide awake clock, driven by the system's suspend and resume events where a
 *  publisher exists (desktop) and by its own sampling everywhere (including orcad). */
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
