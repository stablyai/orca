import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaneTimers } from './pane-timers'

afterEach(() => {
  vi.useRealTimers()
})

describe('PaneTimers', () => {
  it('runs once under the key its pane moved to', () => {
    vi.useFakeTimers()
    const timers = new PaneTimers()
    const run = vi.fn()
    timers.defer('a', 10, run)
    timers.move('a', 'b')
    vi.advanceTimersByTime(10)
    expect(run).toHaveBeenCalledExactlyOnceWith('b')
  })

  it('replaces on defer, keeps on deferUnlessPending, and stops on cancel', () => {
    vi.useFakeTimers()
    const timers = new PaneTimers()
    const first = vi.fn()
    const second = vi.fn()
    timers.defer('a', 10, first)
    timers.defer('a', 10, second)
    timers.deferUnlessPending('a', 10, first)
    vi.advanceTimersByTime(10)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledOnce()
    timers.defer('a', 10, first)
    timers.cancel('a')
    vi.advanceTimersByTime(10)
    expect(first).not.toHaveBeenCalled()
  })
})
