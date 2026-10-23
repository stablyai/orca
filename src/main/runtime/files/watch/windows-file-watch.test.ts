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

import {
  WINDOWS_RUNTIME_FILE_WATCH_LEADING_MS,
  WINDOWS_RUNTIME_FILE_WATCH_REFRESH_MS,
  watchWindowsRuntimeFileExplorer
} from './windows-file-watch'

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
    // Raw events every 50 ms: a resetting debounce would never fire.
    for (let elapsed = 0; elapsed < 2_000; elapsed += 50) {
      fsWatch.listener?.()
      vi.advanceTimersByTime(50)
    }
    // One whole-tree refresh per window, not one per raw event.
    expect(callback).toHaveBeenCalledTimes(2_000 / WINDOWS_RUNTIME_FILE_WATCH_REFRESH_MS)
    expect(callback).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])
  })

  it('refreshes a one-off save after a quiet period on the short leading delay', () => {
    const callback = vi.fn()
    watchWindowsRuntimeFileExplorer('C:\\repo', callback, vi.fn())
    fsWatch.listener?.()
    vi.advanceTimersByTime(WINDOWS_RUNTIME_FILE_WATCH_LEADING_MS)
    expect(callback).toHaveBeenCalledTimes(1)

    // A change right after that refresh waits out the steady interval.
    fsWatch.listener?.()
    vi.advanceTimersByTime(WINDOWS_RUNTIME_FILE_WATCH_REFRESH_MS - 1)
    expect(callback).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(callback).toHaveBeenCalledTimes(2)
  })
})
