import { afterEach, describe, expect, it, vi } from 'vitest'
import { RelayWallClockTimer } from './relay-wall-clock-timer'

function resumeSource(): {
  subscribe: (onResume: () => void) => () => void
  resume: () => void
  count: () => number
} {
  const listeners = new Set<() => void>()
  return {
    subscribe: (onResume) => {
      listeners.add(onResume)
      onResume()
      return () => listeners.delete(onResume)
    },
    resume: () => {
      for (const listener of Array.from(listeners)) {
        listener()
      }
    },
    count: () => listeners.size
  }
}

describe('RelayWallClockTimer', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs a task that fell due during a sleep as soon as the machine resumes', () => {
    vi.useFakeTimers()
    let wall = 1_000_000
    const source = resumeSource()
    const timer = new RelayWallClockTimer(() => wall, source.subscribe)
    const task = vi.fn()
    timer.schedule(180_000, task)
    // Asleep: the wall clock moves, the timer clock does not.
    wall += 200_000
    source.resume()
    expect(task).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(180_000)
    expect(task).toHaveBeenCalledTimes(1)
    expect(source.count()).toBe(0)
  })

  it('re-arms from the wall clock when the machine resumes before the task is due', () => {
    vi.useFakeTimers()
    let wall = 1_000_000
    const source = resumeSource()
    const timer = new RelayWallClockTimer(() => wall, source.subscribe)
    const task = vi.fn()
    timer.schedule(180_000, task)
    // A 60 s sleep: the timer clock lost it, so 120 s of wall time are left.
    wall += 60_000
    source.resume()
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(119_000)
    expect(task).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(task).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(180_000)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('does not run a due task on the state report at subscribe, and never after cancel', () => {
    vi.useFakeTimers()
    const source = resumeSource()
    const timer = new RelayWallClockTimer(() => 0, source.subscribe)
    const task = vi.fn()
    timer.schedule(0, task)
    expect(task).not.toHaveBeenCalled()
    timer.cancel()
    source.resume()
    vi.advanceTimersByTime(1_000)
    expect(task).not.toHaveBeenCalled()
    expect(source.count()).toBe(0)
  })
})
