import { describe, expect, it } from 'vitest'
import { AWAKE_CLOCK_HEARTBEAT_MS, createAwakeClock } from './awake-clock'

type CounterModel = 'counts sleep (macOS/Windows Node)' | 'stops in sleep (Linux)'

/** Wall and monotonic clocks the test moves. Awake time fires the heartbeat (an overdue beat fires
 *  on wake); sleep fires nothing, and advances the monotonic counter only where that runtime's
 *  counter counts sleep. */
function testClocks(model: CounterModel) {
  const time = { wall: 1_794_244_112_215, monotonic: 0 }
  let pending: (() => void) | null = null
  let beatOverdue = false
  const beat = (): void => {
    const due = pending
    pending = null
    due?.()
  }
  return {
    time,
    sources: {
      wallNow: () => time.wall,
      monotonicNow: () => time.monotonic,
      after: (onBeat: () => void) => {
        pending = onBeat
      }
    },
    awake(ms: number) {
      if (beatOverdue) {
        beatOverdue = false
        beat()
      }
      for (let left = ms; left > 0; left -= AWAKE_CLOCK_HEARTBEAT_MS) {
        const step = Math.min(left, AWAKE_CLOCK_HEARTBEAT_MS)
        time.wall += step
        time.monotonic += step
        if (step === AWAKE_CLOCK_HEARTBEAT_MS) {
          beat()
        }
      }
    },
    asleep(ms: number) {
      beatOverdue = true
      time.wall += ms
      if (model === 'counts sleep (macOS/Windows Node)') {
        time.monotonic += ms
      }
    }
  }
}

const MODELS: CounterModel[] = ['counts sleep (macOS/Windows Node)', 'stops in sleep (Linux)']
const SETTLE = 120_000

describe.each(MODELS)('awake clock on a monotonic counter that %s', (model) => {
  it('advances with awake time, including stretches with no reads', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    const start = clock.now()
    expect(start).toBe(clocks.time.wall)
    clocks.awake(60 * 60_000)
    expect(clock.now() - start).toBe(60 * 60_000)
    expect(clock.settled(SETTLE)).toBe(true)
  })

  it('does not count the time between suspend and resume', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    const start = clock.now()
    clocks.awake(2_000)
    clock.suspend()
    clocks.asleep(665_000)
    // A timer that fires on wake before the resume event is delivered still reads the frozen clock.
    expect(clock.now() - start).toBe(2_000)
    clock.resume()
    clocks.awake(3_000)
    expect(clock.now() - start).toBe(5_000)
  })

  it('keeps the earliest suspend when a dark wake re-suspends without a resume', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    const start = clock.now()
    clock.suspend()
    clocks.asleep(500_000)
    clocks.awake(2_000)
    clock.suspend()
    clocks.asleep(665_000)
    clock.resume()
    expect(clock.now() - start).toBe(0)
  })

  it('does not count a sleep that no power event reported', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    const start = clock.now()
    clocks.awake(AWAKE_CLOCK_HEARTBEAT_MS)
    clocks.asleep(600_000)
    clocks.awake(2_000)
    expect(clock.now() - start).toBe(AWAKE_CLOCK_HEARTBEAT_MS + 2_000)
  })

  it('stays suspended through a dark wake while the resume event is late', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    clock.suspend()
    clocks.asleep(600_000)
    clocks.awake(2_000)
    expect(clock.settled(SETTLE)).toBe(false)
    clocks.asleep(600_000)
    clocks.awake(100_000)
    expect(clock.settled(SETTLE)).toBe(false)
  })

  it('resumes by itself once the process has run for minutes after a lost resume event', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    clock.suspend()
    clocks.asleep(600_000)
    const frozen = clock.now()
    clocks.awake(100_000)
    expect(clock.now()).toBe(frozen)
    expect(clock.settled(SETTLE)).toBe(false)
    clocks.awake(20_000)
    // The two minutes it ran count as awake; the sleep before them does not.
    expect(clock.now()).toBe(frozen + 120_000)
    expect(clock.settled(SETTLE)).toBe(true)
  })
})

describe.each(MODELS)('awake clock settling on a monotonic counter that %s', (model) => {
  it('is settled when the machine has not slept', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    expect(clock.settled(SETTLE)).toBe(true)
    clocks.awake(60_000)
    expect(clock.settled(SETTLE)).toBe(true)
  })

  it('is not settled while suspended, including a dark wake inside a suspension', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    clock.suspend()
    clocks.asleep(510_000)
    // macOS dark wake: timers run for ~2s with no resume event.
    clocks.awake(2_000)
    expect(clock.settled(SETTLE)).toBe(false)
  })

  it('waits for the settle period after a resume', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    clock.suspend()
    clocks.asleep(600_000)
    clock.resume()
    // A dark wake that does report resume still lasts only seconds.
    clocks.awake(2_000)
    expect(clock.settled(SETTLE)).toBe(false)
    clocks.awake(SETTLE - 2_000)
    expect(clock.settled(SETTLE)).toBe(true)
  })

  it('waits for the settle period after a sleep that no power event reported', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    expect(clock.settled(SETTLE)).toBe(true)
    clocks.awake(AWAKE_CLOCK_HEARTBEAT_MS)
    clocks.asleep(510_000)
    clocks.awake(2_000)
    expect(clock.settled(SETTLE)).toBe(false)
    clocks.awake(100_000)
    expect(clock.settled(SETTLE)).toBe(false)
    clocks.awake(18_000)
    expect(clock.settled(SETTLE)).toBe(true)
  })

  it('settles on schedule when the wall clock is corrected backward after a resume', () => {
    const clocks = testClocks(model)
    const clock = createAwakeClock(clocks.sources)
    clock.suspend()
    clocks.asleep(600_000)
    clock.resume()
    clocks.awake(30_000)
    clocks.time.wall -= 60 * 60_000
    clocks.awake(80_000)
    expect(clock.settled(SETTLE)).toBe(false)
    clocks.awake(10_000)
    expect(clock.settled(SETTLE)).toBe(true)
  })
})
