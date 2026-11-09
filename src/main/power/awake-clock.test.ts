import { describe, expect, it } from 'vitest'
import { createAwakeClock } from './awake-clock'

/** A wall and a monotonic clock the test moves; sleeping advances only the wall clock, as the
 *  monotonic clock does on macOS and Linux. */
function testClocks() {
  const time = { wall: 1_794_244_112_215, monotonic: 0 }
  return {
    time,
    sources: { wallNow: () => time.wall, monotonicNow: () => time.monotonic },
    awake(ms: number) {
      time.wall += ms
      time.monotonic += ms
    },
    asleep(ms: number) {
      time.wall += ms
    }
  }
}

describe('awake clock', () => {
  it('follows the wall clock while no power events arrive', () => {
    const clocks = testClocks()
    const clock = createAwakeClock(clocks.sources)
    const start = clock.now()
    expect(start).toBe(clocks.time.wall)
    clocks.awake(90_000)
    expect(clock.now() - start).toBe(90_000)
  })

  it('does not count the time between suspend and resume', () => {
    const clocks = testClocks()
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
    const clocks = testClocks()
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

  it('resumes by itself once the process has run for minutes after a lost resume event', () => {
    const clocks = testClocks()
    const clock = createAwakeClock(clocks.sources)
    clock.suspend()
    clocks.asleep(600_000)
    const frozen = clock.now()
    clocks.awake(119_000)
    expect(clock.now()).toBe(frozen)
    clocks.awake(1_000)
    // Counting restarts from here; the suspended stretch stays excluded.
    expect(clock.now()).toBe(frozen)
    clocks.awake(5_000)
    expect(clock.now()).toBe(frozen + 5_000)
  })
})

describe('awake clock settling', () => {
  const SETTLE = 120_000

  it('is settled when the machine has not slept', () => {
    const clocks = testClocks()
    const clock = createAwakeClock(clocks.sources)
    expect(clock.settled(SETTLE)).toBe(true)
    clocks.awake(60_000)
    expect(clock.settled(SETTLE)).toBe(true)
  })

  it('is not settled while suspended, including a dark wake inside a suspension', () => {
    const clocks = testClocks()
    const clock = createAwakeClock(clocks.sources)
    clock.suspend()
    clocks.asleep(510_000)
    // macOS dark wake: timers run for ~2s with no resume event.
    clocks.awake(2_000)
    expect(clock.settled(SETTLE)).toBe(false)
  })

  it('waits for the settle period after a resume', () => {
    const clocks = testClocks()
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

  it('treats a wall-clock jump the monotonic clock did not see as a wake', () => {
    const clocks = testClocks()
    const clock = createAwakeClock(clocks.sources)
    expect(clock.settled(SETTLE)).toBe(true)
    clocks.awake(30_000)
    clocks.asleep(510_000)
    clocks.awake(2_000)
    expect(clock.settled(SETTLE)).toBe(false)
    clocks.awake(60_000)
    expect(clock.settled(SETTLE)).toBe(false)
    clocks.awake(60_000)
    expect(clock.settled(SETTLE)).toBe(true)
  })
})
