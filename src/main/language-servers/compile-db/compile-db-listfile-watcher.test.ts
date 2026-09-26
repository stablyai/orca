import { EventEmitter } from 'node:events'
import { vi, afterEach, describe, expect, it } from 'vitest'
import type { FSWatcher, WatchEventType, watch as fsWatch } from 'node:fs'
import { createListfileWatcher, DEBOUNCE_DEFAULT_MS } from './compile-db-listfile-watcher'

type FakeWatch = {
  watch: typeof fsWatch
  emit: (event: WatchEventType, filename: string | null) => void
  emitError: () => void
  closeCount: () => number
  /** The options object passed to the last watch() call (for recursive asserts). */
  lastOptions: () => unknown
}

function createFakeWatch(): FakeWatch {
  let listener: ((event: WatchEventType, filename: string | null) => void) | null = null
  let closes = 0
  let options: unknown = undefined
  const fakeWatcher = new EventEmitter() as EventEmitter & { close: () => void; unref?: () => void }
  fakeWatcher.close = () => {
    closes += 1
  }
  fakeWatcher.unref = () => {}
  return {
    watch: ((
      _dir: string,
      opts: unknown,
      cb: (event: WatchEventType, filename: string | null) => void
    ) => {
      // node:fs `watch` allows (dir, opts, cb); some callers pass (dir, cb).
      const handler =
        typeof cb === 'function'
          ? cb
          : (opts as (event: WatchEventType, filename: string | null) => void)
      options = typeof cb === 'function' ? opts : undefined
      listener = handler
      return fakeWatcher as unknown as FSWatcher
    }) as unknown as typeof fsWatch,
    emit: (event, filename) => {
      listener?.(event, filename)
    },
    emitError: () => {
      fakeWatcher.emit('error')
    },
    closeCount: () => closes,
    lastOptions: () => options
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('createListfileWatcher — single filename (CMake: CMakeLists.txt)', () => {
  it('fires onChange only for CMakeLists.txt changes (debounced), not other files', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: number[] = []
    const watcher = createListfileWatcher(
      'C:/proj',
      ['CMakeLists.txt'],
      () => calls.push(1),
      () => {},
      fake.watch
    )

    fake.emit('change', 'CMakeLists.txt')
    fake.emit('change', 'main.cpp')
    fake.emit('change', 'CMakeLists.txt')
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([1])
    watcher.dispose()
  })

  it('does not fire for unrelated filenames', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: string[] = []
    const watcher = createListfileWatcher(
      'C:/proj',
      ['CMakeLists.txt'],
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
    const watcher = createListfileWatcher(
      'C:/proj',
      ['CMakeLists.txt'],
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
    const watcher = createListfileWatcher(
      'C:/proj',
      ['CMakeLists.txt'],
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
})

describe('createListfileWatcher — multi filename (GN: BUILD.gn + .gn)', () => {
  it('fires for either BUILD.gn or .gn, not for other files', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: string[] = []
    const watcher = createListfileWatcher(
      'C:/proj',
      ['BUILD.gn', '.gn'],
      () => calls.push('x'),
      () => {},
      fake.watch
    )

    fake.emit('change', 'BUILD.gn')
    fake.emit('change', 'BUILD.gn')
    fake.emit('change', 'main.cpp')
    fake.emit('change', '.gn')
    expect(calls).toEqual([])
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual(['x'])
    watcher.dispose()
  })

  it('re-triggers separately for each watched file across debounce windows', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: string[] = []
    const watcher = createListfileWatcher(
      'C:/proj',
      ['BUILD.gn', '.gn'],
      () => calls.push('hit'),
      () => {},
      fake.watch
    )

    fake.emit('change', 'BUILD.gn')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual(['hit'])

    fake.emit('change', '.gn')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual(['hit', 'hit'])
    watcher.dispose()
  })

  it('ignores case variants of watched filenames', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: number[] = []
    const watcher = createListfileWatcher(
      'C:/proj',
      ['BUILD.gn', '.gn'],
      () => calls.push(1),
      () => {},
      fake.watch
    )

    // build.gn (lowercase) is a different filename on a case-sensitive FS and is
    // not in the watched set; on Windows (case-insensitive FS) node:fs reports
    // the on-disk casing, which the caller supplies, so lowercase stays ignored.
    fake.emit('change', 'build.gn')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([])
    watcher.dispose()
  })
})

describe('createListfileWatcher — recursive (GN subdirs: src/foo/BUILD.gn)', () => {
  it('passes recursive:true so subdir BUILD.gn edits regenerate (spec §8)', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: number[] = []
    const watcher = createListfileWatcher(
      'C:/proj',
      ['BUILD.gn', '.gn'],
      () => calls.push(1),
      () => {},
      fake.watch,
      undefined,
      true
    )
    expect((fake.lastOptions() as { recursive?: boolean })?.recursive).toBe(true)
    // A subdir BUILD.gn fires (node reports a path relative to the root).
    fake.emit('change', 'src/foo/BUILD.gn')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([1])
    watcher.dispose()
  })

  it('defaults to recursive:false so CMake root-only watching stays scoped', () => {
    const fake = createFakeWatch()
    const watcher = createListfileWatcher(
      'C:/proj',
      ['CMakeLists.txt'],
      () => {},
      () => {},
      fake.watch
    )
    expect((fake.lastOptions() as { recursive?: boolean } | undefined)?.recursive).toBe(false)
    watcher.dispose()
  })

  it('still fires for a root-level BUILD.gn when recursive', async () => {
    vi.useFakeTimers()
    const fake = createFakeWatch()
    const calls: number[] = []
    const watcher = createListfileWatcher(
      'C:/proj',
      ['BUILD.gn', '.gn'],
      () => calls.push(1),
      () => {},
      fake.watch,
      undefined,
      true
    )
    fake.emit('change', 'BUILD.gn')
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([1])
    watcher.dispose()
  })
})

describe('createListfileWatcher — lifecycle', () => {
  it('disposes the underlying fs watcher', () => {
    const fake = createFakeWatch()
    const watcher = createListfileWatcher(
      'C:/proj',
      ['CMakeLists.txt'],
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
    const watcher = createListfileWatcher(
      'C:/proj',
      ['CMakeLists.txt'],
      () => calls.push(1),
      () => {},
      fake.watch
    )

    fake.emit('change', 'CMakeLists.txt')
    watcher.dispose()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_DEFAULT_MS)
    expect(calls).toEqual([])
  })

  it('routes a watcher error to onError', () => {
    const fake = createFakeWatch()
    let errored = 0
    const watcher = createListfileWatcher(
      'C:/proj',
      ['CMakeLists.txt'],
      () => {},
      () => (errored += 1),
      fake.watch
    )
    fake.emitError()
    expect(errored).toBe(1)
    watcher.dispose()
  })
})
