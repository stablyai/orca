import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAwakeClock, WAKE_SETTLE_MS } from '../power/awake-clock'
import { readMacosFullWake, readMacosWakeState } from '../power/macos-full-wake'
import {
  backgroundRunSlept,
  runGate,
  startWithinLimit,
  watchBackgroundRun
} from './bot-background-run'
import { backgroundRunPower, sharedFullWakeReading } from './bot-background-run-power'
import {
  ASLEEP_RETRY_AFTER_MS,
  type BackgroundRuns,
  backgroundRunSessionIds,
  slotTaken,
  withBackgroundRun,
  withoutBackgroundRun
} from './bot-look-around-state'
import { WITH_CLOCKS } from './bot-background-run.test-fixture'

const MINUTE = 60_000
const FULL_WAKE = 'CPU Graphics Audio Network'
const DARK_WAKE = 'CPU Network'

/** The production power on an awake clock driven by simulated suspend and resume events, as the
 *  desktop's powerMonitor drives it, reading a simulated Mac's `pmset -g systemstate`. Its counter
 *  counts sleep, as macOS's does. */
function simulatedHost(start: { capabilities?: string } = {}) {
  let countedSleep = 0
  let generation = 0
  let suspends = 0
  // As `pmset -g systemstate` lists them: a dark wake runs without Graphics and Audio.
  let capabilities = start.capabilities ?? FULL_WAKE
  const clock = createAwakeClock({
    wallNow: () => Date.now(),
    monotonicNow: () => performance.now() + countedSleep,
    after: (beat, ms) => void setTimeout(beat, ms)
  })
  const holds: string[] = []
  const power = backgroundRunPower({
    clock,
    readFullWake: () =>
      readMacosFullWake(
        async () => `Current System Capabilities are: ${capabilities} \nCurrent Power State: 4\n`
      ),
    generation: () => generation,
    suspends: () => suspends,
    holdAwake: () => {
      holds.push('held')
      return () => holds.push('released')
    }
  })
  const suspend = () => {
    clock.suspend()
    suspends += 1
    generation += 1
  }
  const resume = (into: string) => {
    capabilities = into
    clock.resume()
    generation += 1
  }
  return {
    power,
    holds,
    suspend,
    resume,
    /** The system state changes with no power event the app sees. */
    setCapabilities: (into: string) => (capabilities = into),
    /** Asleep `ms`, then woken `into` a full or dark wake: no timers run while asleep; the wall
     *  clock and the counter move on, and timers due meanwhile fire just after waking. */
    sleep: async (ms: number, into = FULL_WAKE) => {
      suspend()
      vi.setSystemTime(Date.now() + ms)
      countedSleep += ms
      resume(into)
      await vi.advanceTimersByTimeAsync(0)
    }
  }
}

describe('a background run on a host that sleeps', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('admits a scheduled run only in full wake, however long a dark wake lasts', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost()
    expect(await host.power.checkFullWake()).toBe(true)
    // Asleep an hour, then a dark wake at 3 AM that lasts ten minutes, well past the settle.
    await host.sleep(60 * MINUTE, DARK_WAKE)
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(host.power.settled()).toBe(true)
    expect(await host.power.checkFullWake()).toBe(false)
    // Opened in the morning: admitted once it has been awake two minutes.
    await host.sleep(5 * 60 * MINUTE)
    await vi.advanceTimersByTimeAsync(WAKE_SETTLE_MS - 1)
    expect(await host.power.checkFullWake()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await host.power.checkFullWake()).toBe(true)
  })

  it('never admits a process that starts inside a dark wake, with no wake seen yet', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost({ capabilities: DARK_WAKE })
    // A fresh clock has seen no wake, so it is settled at once; the system state still says dark.
    expect(host.power.settled()).toBe(true)
    expect(await host.power.checkFullWake()).toBe(false)
  })

  it('reads the system state afresh each time, so a change with no power event is seen', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost()
    expect(await host.power.checkFullWake()).toBe(true)
    host.setCapabilities(DARK_WAKE)
    expect(await host.power.checkFullWake()).toBe(false)
    host.setCapabilities(FULL_WAKE)
    expect(await host.power.checkFullWake()).toBe(true)
  })

  it('reads an unreadable system state as not full wake', async () => {
    expect(await readMacosFullWake(async () => 'pmset: unexpected')).toBeNull()
    expect(
      await readMacosFullWake(async () => {
        throw new Error('ETIMEDOUT')
      })
    ).toBeNull()
    expect(
      await readMacosFullWake(async () => `Current System Capabilities are: ${DARK_WAKE}`)
    ).toBe(false)
  })

  it('knows a run was cut short by a reported suspend, however short', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost()
    const watch = watchBackgroundRun(host.power, 's-short')
    await vi.advanceTimersByTimeAsync(MINUTE)
    host.suspend()
    vi.setSystemTime(Date.now() + 2_000)
    host.resume(FULL_WAKE)
    expect(watch.slept()).toBe(true)
    watch.end()
  })

  it('counts its limit in awake time and knows the host slept', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost()
    const watch = watchBackgroundRun(host.power, 's1')
    let ended: unknown
    void watch.limit(new Promise<never>(() => {}), 10 * MINUTE).then((value) => (ended = value))
    await vi.advanceTimersByTimeAsync(4 * MINUTE)
    expect(watch.slept()).toBe(false)
    await host.sleep(45 * MINUTE)
    expect(ended).toBeUndefined()
    expect(watch.slept()).toBe(true)
    await vi.advanceTimersByTimeAsync(6 * MINUTE - 1)
    expect(ended).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(ended).toBe('timed_out')
    watch.end()
    watch.end()
    expect(host.holds).toEqual(['held', 'released'])
  })

  it('never lets runs sleep cut short use a slot up, only spacing the tries', () => {
    const slot = 1_000
    const asleep = (at: number) => ({
      sessionId: `s${at}`,
      startedAt: at,
      endedAt: at + 1,
      error: 'missed',
      asleep: true as const
    })
    const later = (at: number) => at + 1 + ASLEEP_RETRY_AFTER_MS
    expect(slotTaken([], slot, slot)).toBe(false)
    expect(slotTaken([{ sessionId: 'old', startedAt: slot - 1, endedAt: slot }], slot, slot)).toBe(
      false
    )
    const cutShort = [asleep(slot), asleep(slot + 10), asleep(slot + 20), asleep(slot + 30)]
    // Right after one, the slot waits; once the spacing passes, it is due again, however many.
    expect(slotTaken(cutShort, slot, slot + 40)).toBe(true)
    expect(slotTaken(cutShort, slot, later(slot + 30))).toBe(false)
    expect(
      slotTaken([{ sessionId: 'failed', startedAt: slot, error: 'x' }], slot, slot + 9e9)
    ).toBe(true)
  })

  it('takes back a deferred run with the older run its begin trimmed, and keeps its session a run', () => {
    const full = {
      runs: [
        { sessionId: 'oldest', startedAt: 1, endedAt: 2, error: 'failed' },
        { sessionId: 'newer', startedAt: 3, endedAt: 4 }
      ]
    }
    const begun = withBackgroundRun(full, 'deferred', 5, 2)
    expect(begun.runs.map((run) => run.sessionId)).toEqual(['newer', 'deferred'])
    const back = withoutBackgroundRun(begun, 'deferred', full)
    expect(back.runs).toEqual(full.runs)
    expect(backgroundRunSessionIds(back)).toEqual(['deferred', 'oldest', 'newer'])
  })

  it('trims runs sleep cut short before any other, so retries never push out what happened', () => {
    const failed = {
      sessionId: 'failed',
      startedAt: 1,
      endedAt: 2,
      error: 'x',
      alerted: true as const
    }
    const cut = (id: string, at: number) => ({
      sessionId: id,
      startedAt: at,
      endedAt: at + 1,
      error: 'missed',
      asleep: true as const
    })
    const state: BackgroundRuns = { runs: [failed, cut('c1', 3), cut('c2', 5)] }
    const next = withBackgroundRun(state, 'new', 7, 3)
    expect(next.runs.map((run) => run.sessionId)).toEqual(['failed', 'c2', 'new'])
    expect(next.pastSessionIds).toEqual(['c1'])
  })

  it('fences a run past its limit at both its opening message and delivery, scheduled or not', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost()
    for (const scheduled of [true, false]) {
      const watch = watchBackgroundRun(host.power, `s-fence-${scheduled}`)
      const gate = runGate(host.power, { scheduled, mayStart: () => true })
      const start = startWithinLimit(
        watch,
        {
          setup: async () => ({ next: () => new Promise<never>(() => {}), dispose: () => {} }),
          start: () => new Promise<never>(() => {}),
          stopTurn: async () => {}
        },
        MINUTE
      )
      gate.attach(start)
      await gate.beforeFirstMessage()
      expect(gate.beforeDelivery()).toBe(true)
      await vi.advanceTimersByTimeAsync(MINUTE)
      await expect(start.ended).resolves.toBe('timed_out')
      await expect(gate.beforeFirstMessage()).rejects.toThrow()
      expect(gate.beforeDelivery()).toBe(false)
      // Fenced by the limit, never deferred: the run stands as it was recorded.
      expect(gate.deferred()).toBe(false)
      watch.end()
    }
  })

  it("holds a scheduled run's delivery to the stretch of being awake it was admitted in", async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost()
    const gate = runGate(host.power, { scheduled: true, mayStart: () => true })
    await gate.beforeFirstMessage()
    expect(gate.beforeDelivery()).toBe(true)
    // A sleep and wake while the message was being recorded: delivery is refused and deferred.
    await host.sleep(30_000)
    await vi.advanceTimersByTimeAsync(WAKE_SETTLE_MS)
    expect(gate.beforeDelivery()).toBe(false)
    expect(gate.deferred()).toBe(true)
    expect(() => gate.afterStart()).toThrow()
  })

  it('keeps tracking sleep after the hold goes, until the run ends', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost()
    const watch = watchBackgroundRun(host.power, 's-stopping')
    watch.releaseHold()
    expect(host.holds).toEqual(['held', 'released'])
    // Asleep while its stop lands: still this run's sleep, and remembered once it ends.
    await host.sleep(5 * MINUTE)
    expect(watch.slept()).toBe(true)
    expect(backgroundRunSlept('s-stopping')).toBe(true)
    watch.end()
    expect(backgroundRunSlept('s-stopping')).toBe(true)
    expect(host.holds).toEqual(['held', 'released'])
  })

  it('handles a rejected stop when a start returns after its run timed out', async () => {
    vi.useFakeTimers(WITH_CLOCKS)
    const host = simulatedHost()
    const watch = watchBackgroundRun(host.power, 's-late-stop')
    const ready = Promise.withResolvers<void>()
    const error = new Error('stop failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const start = startWithinLimit(
        watch,
        {
          setup: async () => ({ next: () => new Promise<never>(() => {}), dispose: () => {} }),
          start: async () => {
            await ready.promise
            return { sessionId: 's-late-stop', clientMessageId: 'm', fingerprint: 'f' }
          },
          stopTurn: async () => {
            throw error
          }
        },
        MINUTE
      )
      await vi.advanceTimersByTimeAsync(MINUTE)
      await expect(start.ended).resolves.toBe('timed_out')
      start.dispose()
      watch.end()
      ready.resolve()
      await vi.advanceTimersByTimeAsync(0)
      expect(warn).toHaveBeenCalledWith(expect.any(String), error)
    } finally {
      warn.mockRestore()
      watch.end()
    }
  })
})

describe("the host's full-wake reading, shared by the look-around and tidy-up runners", () => {
  /** Both runners on one host checking on each minute tick, as the automation scheduler runs them. */
  function host(reading: boolean | null | 'timeout') {
    let now = 0
    let generation = 0
    const state = { reading, spawns: 0 }
    const read = sharedFullWakeReading({
      read: () =>
        readMacosWakeState(async () => {
          state.spawns += 1
          if (state.reading === 'timeout') {
            throw new Error('pmset exited on timeout')
          }
          return state.reading === null
            ? 'pmset: no capabilities'
            : `Current System Capabilities are: ${state.reading ? FULL_WAKE : DARK_WAKE}`
        }),
      generation: () => generation,
      now: () => now
    })
    const runner = () =>
      backgroundRunPower({
        clock: { now: () => now, settled: () => true },
        readFullWake: read,
        generation: () => generation,
        suspends: () => generation,
        holdAwake: () => () => {}
      })
    const runners = [runner(), runner()]
    return {
      state,
      powerEvent: () => (generation += 1),
      /** One tick: both runners check at once; true when either may admit. */
      tick: async () => {
        now += MINUTE
        const checks = await Promise.all(runners.map((power) => power.checkFullWake()))
        return checks.some(Boolean)
      },
      /** A run admitted on this tick checks again at its opening message. */
      openingMessage: () => runners[0]!.checkFullWake()
    }
  }

  it('reads a dark wake once per tick, not once per runner', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mac = host(false)
    for (let tick = 0; tick < 10; tick += 1) {
      expect(await mac.tick()).toBe(false)
    }
    expect(mac.state.spawns).toBe(10)
  })

  it.each([
    [10, 4],
    [100, 8]
  ])('backs off reading an unknown state (%i ticks)', async (ticks, spawns) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mac = host(null)
    for (let tick = 0; tick < ticks; tick += 1) {
      expect(await mac.tick()).toBe(false)
    }
    expect(mac.state.spawns).toBe(spawns)
  })

  it('reads again on the next tick after pmset fails to answer, admitting as soon as it does', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mac = host('timeout')
    for (let tick = 0; tick < 5; tick += 1) {
      expect(await mac.tick()).toBe(false)
    }
    mac.state.reading = true
    expect(await mac.tick()).toBe(true)
    expect(mac.state.spawns).toBe(6)
  })

  it('reads a full wake afresh for each admission, and reads at once after a power event', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mac = host(null)
    expect(await mac.tick()).toBe(false)
    expect(await mac.tick()).toBe(false)
    mac.state.reading = true
    // Backing off two minutes after the second unknown reading.
    expect(await mac.tick()).toBe(false)
    expect(mac.state.spawns).toBe(2)
    mac.powerEvent()
    expect(await mac.tick()).toBe(true)
    const spawns = mac.state.spawns
    mac.state.reading = false
    expect(await mac.openingMessage()).toBe(false)
    mac.state.reading = true
    expect(await mac.tick()).toBe(true)
    expect(await mac.openingMessage()).toBe(true)
    expect(mac.state.spawns).toBe(spawns + 3)
  })
})
