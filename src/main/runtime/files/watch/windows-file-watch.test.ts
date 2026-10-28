import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsWatch = vi.hoisted(() => {
  const state: { listener: (() => void) | null } = { listener: null }
  return state
})
vi.mock('node:fs', () => ({
  watch: (_root: string, _options: unknown, listener: () => void) => {
    fsWatch.listener = listener
    return Object.assign(new EventEmitter(), { close: vi.fn() })
  }
}))

import { watchWindowsRuntimeFileExplorer } from './windows-file-watch'

describe('watchWindowsRuntimeFileExplorer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps emitting overflow refreshes while raw events never stop', () => {
    const callback = vi.fn()
    watchWindowsRuntimeFileExplorer('C:\\repo', callback, vi.fn())
    // Sustained 50ms events would starve a resetting debounce.
    for (let elapsed = 0; elapsed < 2_000; elapsed += 50) {
      fsWatch.listener?.()
      vi.advanceTimersByTime(50)
    }
    expect(callback).toHaveBeenCalledTimes(4)
    expect(callback).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])
  })

  it('refreshes a one-off save after a quiet period on the short leading delay', () => {
    const callback = vi.fn()
    watchWindowsRuntimeFileExplorer('C:\\repo', callback, vi.fn())
    fsWatch.listener?.()
    vi.advanceTimersByTime(149)
    expect(callback).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(1)

    fsWatch.listener?.()
    vi.advanceTimersByTime(499)
    expect(callback).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(2)
  })
})
