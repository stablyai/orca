import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsWatch = vi.hoisted(() => {
  const state: {
    listener: ((eventType?: string, filename?: string | null) => void) | null
  } = { listener: null }
  return state
})
vi.mock('node:fs', () => ({
  watch: (
    _root: string,
    _options: unknown,
    listener: (eventType?: string, filename?: string | null) => void
  ) => {
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

  it('discards generated-file storms before scheduling refreshes and still delivers source edits', () => {
    const callback = vi.fn()
    watchWindowsRuntimeFileExplorer('C:\\repo', callback, vi.fn())
    const excludedPaths = [
      'node_modules\\dependency\\index.js',
      'packages/app/node_modules/dependency/index.js',
      '.git\\objects\\pack\\data.pack',
      'app\\dist\\bundle.js',
      'app/build/bundle.js',
      '.next\\cache\\file',
      '.cache/file',
      'target\\debug\\binary',
      '.venv/lib/module.py',
      'app\\__pycache__\\module.pyc'
    ]
    for (let elapsed = 0; elapsed < 2_000; elapsed += 10) {
      for (const filename of excludedPaths) {
        fsWatch.listener?.(elapsed % 20 === 0 ? 'rename' : 'change', filename)
      }
      vi.advanceTimersByTime(10)
    }
    expect(callback).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)

    fsWatch.listener?.('change', 'src\\index.ts')
    vi.advanceTimersByTime(150)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])
  })

  it.each([
    'src\\node_modules_notes.ts',
    'src/not_node_modules/file.ts',
    'node_modules',
    'app\\dist',
    'build',
    'src\\target.ts',
    '',
    null
  ])('preserves conservative refreshes for an included or unknown filename: %s', (filename) => {
    const callback = vi.fn()
    watchWindowsRuntimeFileExplorer('C:\\repo', callback, vi.fn())
    fsWatch.listener?.('rename', filename)
    vi.advanceTimersByTime(150)
    expect(callback).toHaveBeenCalledExactlyOnceWith([
      { kind: 'overflow', absolutePath: 'C:\\repo' }
    ])
  })
})
