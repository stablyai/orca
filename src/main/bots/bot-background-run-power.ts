// The host's power for bots' background runs: the same wake settle as scheduled automations, a
// full-wake reading where the platform has dark wakes, the awake clock, and the desktop's
// idle-sleep hold.
import { getSystemAwakeClock, WAKE_SETTLE_MS, type AwakeClock } from '../power/awake-clock'
import { holdAwakeForBackgroundRun } from '../power/background-run-awake-hold'
import { fullWakeOf, readMacosWakeState, type MacosWakeReading } from '../power/macos-full-wake'
import { systemPowerGeneration, systemSuspendCount } from '../power/system-power-lifecycle'
import type { BackgroundRunPower } from './bot-background-run'

export type BackgroundRunPowerSources = {
  clock: Pick<AwakeClock, 'now' | 'settled'>
  /** True in full wake, false in a dark wake, null when unknown; a platform without dark wakes
   *  reads true. */
  readFullWake: () => Promise<boolean | null>
  /** Changes with every reported suspend and resume. */
  generation: () => number
  suspends: () => number
  holdAwake: () => () => void
}

export function backgroundRunPower(sources: BackgroundRunPowerSources): BackgroundRunPower {
  const { clock } = sources
  const settled = () => clock.settled(WAKE_SETTLE_MS)
  return {
    settled,
    // A full-wake reading is fresh each time, at the tick and again at the opening message, so a
    // capability change with no power event in between can't admit a run.
    async checkFullWake() {
      if (!settled()) {
        return false
      }
      const generation = sources.generation()
      // Unknown is not full wake: the run waits for a reading that says so.
      const full = (await sources.readFullWake()) === true
      return full && settled() && sources.generation() === generation
    },
    suspends: sources.suspends,
    epoch: sources.generation,
    awakeNow: () => clock.now(),
    wallNow: () => Date.now(),
    holdAwake: sources.holdAwake
  }
}

// A reading that isn't full wake serves the other runner's check on the same tick. Output that
// lists no capabilities is read again only after a back-off, doubling to its cap, or after a power
// event; a pmset that didn't answer is read again on the next check, as before.
const NOT_FULL_REUSE_MS = 5_000
const UNKNOWN_FIRST_RETRY_MS = 60_000
const UNKNOWN_MAX_RETRY_MS = 30 * 60_000

/** One reading shared by every runner's checks: checks made while one is read share it. A full-wake
 *  reading is never kept, so each admission still reads afresh; one that isn't can only keep a run
 *  waiting. */
export function sharedFullWakeReading(sources: {
  read: () => Promise<MacosWakeReading>
  generation: () => number
  now: () => number
}): () => Promise<boolean | null> {
  let reading: { generation: number; value: Promise<boolean | null> } | null = null
  let last: { generation: number; value: MacosWakeReading; at: number } | null = null
  let unknownRetryMs = 0
  return () => {
    const generation = sources.generation()
    if (reading?.generation === generation) {
      return reading.value
    }
    const now = sources.now()
    if (last?.generation === generation) {
      if (last.value === 'dark' && now - last.at < NOT_FULL_REUSE_MS) {
        return Promise.resolve(false)
      }
      if (last.value === 'unlisted' && now - last.at < unknownRetryMs) {
        return Promise.resolve(null)
      }
    } else {
      unknownRetryMs = 0
    }
    const value = sources.read().then((read) => {
      last = { generation, value: read, at: sources.now() }
      unknownRetryMs =
        read === 'unlisted'
          ? Math.min(Math.max(unknownRetryMs * 2, UNKNOWN_FIRST_RETRY_MS), UNKNOWN_MAX_RETRY_MS)
          : 0
      return fullWakeOf(read)
    })
    const current = { generation, value }
    reading = current
    void value.finally(() => {
      if (reading === current) {
        reading = null
      }
    })
    return value
  }
}

let systemFullWake: (() => Promise<boolean | null>) | null = null

/** One per runner, sharing the host's full-wake reading. Windows and Linux
 *  have no dark wake a desktop app runs in (Modern Standby freezes it), so the settle alone
 *  decides there. */
export function systemBackgroundRunPower(): BackgroundRunPower {
  const clock = getSystemAwakeClock()
  systemFullWake ??=
    process.platform === 'darwin'
      ? sharedFullWakeReading({
          read: () => readMacosWakeState(),
          generation: systemPowerGeneration,
          now: () => clock.now()
        })
      : async () => true
  return backgroundRunPower({
    clock,
    readFullWake: systemFullWake,
    generation: systemPowerGeneration,
    suspends: systemSuspendCount,
    holdAwake: holdAwakeForBackgroundRun
  })
}
