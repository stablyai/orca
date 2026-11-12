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
})
