import { afterEach, expect, it, vi } from 'vitest'
import { recordSocketDeadlineAppState, startSocketDeadlineClock } from './socket-deadline-clock'

afterEach(() => {
  recordSocketDeadlineAppState('active')
  vi.restoreAllMocks()
})

function createClock() {
  let wallMs = 1_000
  let monotonicMs = 10
  vi.spyOn(Date, 'now').mockImplementation(() => wallMs)
  vi.spyOn(performance, 'now').mockImplementation(() => monotonicMs)
  return {
    set: (nextWallMs: number, nextMonotonicMs: number) => {
      wallMs = nextWallMs
      monotonicMs = nextMonotonicMs
    }
  }
}

it('does not inherit an earlier foreground loss into a fresh foreground deadline', () => {
  const clock = createClock()
  recordSocketDeadlineAppState('background')
  clock.set(10_801_000, 12_010)
  recordSocketDeadlineAppState('active')
  const elapsed = startSocketDeadlineClock()
  clock.set(21_601_000, 24_010)
  expect(elapsed()).toBe(12_000)
})

it('handles a deadline armed outside foreground despite a paused monotonic clock', () => {
  const clock = createClock()
  recordSocketDeadlineAppState('inactive')
  const elapsed = startSocketDeadlineClock()
  clock.set(10_801_000, 12_010)
  expect(elapsed()).toBe(10_800_000)
})

it('does not shorten elapsed monotonic time after a backwards background wall-clock step', () => {
  const clock = createClock()
  const elapsed = startSocketDeadlineClock()
  recordSocketDeadlineAppState('background')
  clock.set(-10_800_000, 12_010)
  expect(elapsed()).toBe(12_000)
})

it('excludes a foreground wall jump after a brief inactive transition', () => {
  const clock = createClock()
  const elapsed = startSocketDeadlineClock()
  clock.set(2_000, 1_010)
  recordSocketDeadlineAppState('inactive')
  clock.set(2_100, 1_110)
  recordSocketDeadlineAppState('active')
  clock.set(10_813_000, 12_010)
  expect(elapsed()).toBe(12_000)
})

it('counts only sleep after a deadline armed partway through a background segment', () => {
  const clock = createClock()
  recordSocketDeadlineAppState('inactive')
  clock.set(61_000, 10)
  const elapsed = startSocketDeadlineClock()
  clock.set(121_000, 10)
  recordSocketDeadlineAppState('active')
  expect(elapsed()).toBe(60_000)
})

it('accumulates sleep across background segments without counting foreground clock changes', () => {
  const clock = createClock()
  const elapsed = startSocketDeadlineClock()
  clock.set(10_801_000, 1_010)
  recordSocketDeadlineAppState('inactive')
  clock.set(10_831_000, 1_010)
  recordSocketDeadlineAppState('background')
  clock.set(10_861_000, 1_010)
  recordSocketDeadlineAppState('active')
  clock.set(21_662_000, 2_010)
  recordSocketDeadlineAppState('background')
  clock.set(21_692_000, 2_010)
  expect(elapsed()).toBe(92_000)
  recordSocketDeadlineAppState('active')
  expect(elapsed()).toBe(92_000)
})
