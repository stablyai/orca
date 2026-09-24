import { EventEmitter } from 'node:events'
import { vi, afterEach, describe, expect, it } from 'vitest'
import type { FSWatcher, WatchEventType, watch as fsWatch } from 'node:fs'
import {
  createCMakeListfileWatcher,
  DEBOUNCE_DEFAULT_MS
} from './compile-db-cmake-listfile-watcher'

type FakeWatch = {
  watch: typeof fsWatch
  emit: (event: WatchEventType, filename: string | null) => void
  closeCount: () => number
}

function createFakeWatch(): FakeWatch {
  let listener: ((event: WatchEventType, filename: string | null) => void) | null = null
  let closes = 0
  const fakeWatcher = new EventEmitter() as EventEmitter & { close: () => void; unref?: () => void }
  fakeWatcher.close = () => {
    closes += 1
  }
  fakeWatcher.unref = () => {}
  return {
    watch: ((_dir: string, cb: (event: WatchEventType, filename: string | null) => void) => {
      listener = cb
      return fakeWatcher as unknown as FSWatcher
    }) as unknown as typeof fsWatch,
    emit: (event, filename) => {
      listener?.(event, filename)
    },
    closeCount: () => closes
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createCMakeListfileWatcher', () => {
  it('fires onChange only for CMakeLists.txt changes (debounced), not other files', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: number[] = []
    const watcher = createCMakeListfileWatcher(
      'C:/proj',
      () => calls.push(1),
      () => {},
      fake.watch
    )

    fake.emit('change', 'CMakeLists.txt')
    fake.emit('change', 'main.cpp')
    fake.emit('change', 'CMakeLists.txt')
    // Mid-debounce: nothing has fired yet (coalesced).
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([1])
    watcher.dispose()
  })

  it('does not fire for unrelated filenames', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: string[] = []
    const watcher = createCMakeListfileWatcher(
      'C:/proj',
      () => calls.push('x'),
      () => {},
      fake.watch
    )

    fake.emit('change', 'README.md')
    fake.emit('rename', 'src/util.cpp')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([])
    watcher.dispose()
  })

  it('re-triggers the callback on a later change after the first', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: number[] = []
    const watcher = createCMakeListfileWatcher(
      'C:/proj',
      () => calls.push(1),
      () => {},
      fake.watch
    )

    fake.emit('change', 'CMakeLists.txt')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([1])

    fake.emit('change', 'CMakeLists.txt')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([1, 1])
    watcher.dispose()
  })

  it('coalesces a burst into a single configure run', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: number[] = []
    const watcher = createCMakeListfileWatcher(
      'C:/proj',
      () => calls.push(1),
      () => {},
      fake.watch
    )

    fake.emit('change', 'CMakeLists.txt')
    fake.emit('change', 'CMakeLists.txt')
    fake.emit('change', 'CMakeLists.txt')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([1])
    watcher.dispose()
  })

  it('disposes the underlying fs watcher', () => {
    const fake = createFakeWatch()
    const watcher = createCMakeListfileWatcher(
      'C:/proj',
      () => {},
      () => {},
      fake.watch
    )
    watcher.dispose()
    expect(fake.closeCount()).toBe(1)
  })

  it('dispose cancels a pending debounced run', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: number[] = []
    const watcher = createCMakeListfileWatcher(
      'C:/proj',
      () => calls.push(1),
      () => {},
      fake.watch
    )

    fake.emit('change', 'CMakeLists.txt')
    watcher.dispose()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([])
  })
})
