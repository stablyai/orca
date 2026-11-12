import { EventEmitter } from 'node:events'
import { statSync, watch } from 'node:fs'
import type * as Fs from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { watcherState } = vi.hoisted(() => ({
  watcherState: new Map<
    string,
    {
      callback: (eventType: string, fileName: string | Buffer | null) => void
      watcher: EventEmitter & { close: () => void }
    }
  >()
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof Fs>('node:fs')
  return {
    ...actual,
    statSync: vi.fn(actual.statSync),
    watch: vi.fn(
      (
        path: string,
        _options: unknown,
        callback: (eventType: string, fileName: string | Buffer | null) => void
      ) => {
        const watcher = new EventEmitter() as EventEmitter & { close: () => void }
        watcher.close = () => watcher.emit('close')
        watcherState.set(path, { callback, watcher })
        return watcher
      }
    )
  }
})
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
  return { ...actual, stat: vi.fn(actual.stat) }
})

import { startShallowDirectoryWatcher } from './parcel-watcher-shallow-subscription'

function emit(path: string, fileName: string): void {
  watcherState.get(path)?.callback('change', fileName)
}

describe('shallow watcher subscription', () => {
  beforeEach(() => {
    watcherState.clear()
    vi.mocked(statSync).mockReset()
    vi.mocked(stat).mockReset()
  })

  it('emits only included primary files, including an existing nested directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      await mkdir(join(root, 'logs'))
      const events: string[] = []
      const { promise, resolve } = Promise.withResolvers<void>()
      const subscription = startShallowDirectoryWatcher(
        root,
        ['HEAD', 'config', 'logs/HEAD'],
        (nextEvents) => {
          events.push(...nextEvents.map((event) => event.path))
          if (
            events.includes(join(root, 'config')) &&
            events.includes(join(root, 'logs', 'HEAD'))
          ) {
            resolve()
          }
        },
        (error) => {
          throw error
        }
      )

      emit(root, 'unrelated')
      emit(join(root, 'logs'), 'unrelated')
      emit(root, 'config')
      emit(join(root, 'logs'), 'HEAD')
      await promise

      expect(events).toContain(join(root, 'config'))
      expect(events).toContain(join(root, 'logs', 'HEAD'))
      expect(events).not.toContain(join(root, 'unrelated'))
      expect(events).not.toContain(join(root, 'logs', 'unrelated'))
      await subscription.unsubscribe()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not forward events after unsubscribe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      const events: string[] = []
      const subscription = startShallowDirectoryWatcher(
        root,
        ['HEAD'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      await subscription.unsubscribe()
      emit(root, 'HEAD')
      const { promise, resolve } = Promise.withResolvers<void>()
      setImmediate(resolve)
      await promise
      expect(events).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a literal backslash in an included filename',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
      const events: string[] = []
      const subscription = startShallowDirectoryWatcher(
        root,
        ['plugin\\name'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      try {
        emit(root, 'plugin\\name')
        expect(events).toEqual([join(root, 'plugin\\name')])
      } finally {
        await subscription.unsubscribe()
        await rm(root, { recursive: true, force: true })
      }
    }
  )

  it('rebinds a nested directory that is replaced, which leaves fs.watch deaf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      await mkdir(join(root, 'logs'))
      const events: string[] = []
      const subscription = startShallowDirectoryWatcher(
        root,
        ['HEAD', 'logs/HEAD'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      const firstNested = watcherState.get(join(root, 'logs'))?.watcher

      // A 'rename' for the nested dir means the inode was swapped, so the old
      // binding is dead and must be replaced rather than reused.
      watcherState.get(root)?.callback('rename', 'logs')

      expect(watcherState.get(join(root, 'logs'))?.watcher).not.toBe(firstNested)
      events.length = 0
      emit(join(root, 'logs'), 'HEAD')
      expect(events).toContain(join(root, 'logs', 'HEAD'))
      await subscription.unsubscribe()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resyncs included files when an initially missing directory becomes watchable', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    let subscription: ReturnType<typeof startShallowDirectoryWatcher> | undefined
    try {
      const defaultWatch = vi.mocked(watch).getMockImplementation()
      if (!defaultWatch) {
        throw new Error('Missing watcher test implementation')
      }
      vi.mocked(watch)
        .mockImplementationOnce(defaultWatch)
        .mockImplementationOnce(() => {
          throw new Error('ENOENT: logs directory does not exist')
        })
      const events: string[] = []
      subscription = startShallowDirectoryWatcher(
        root,
        ['HEAD', 'logs/HEAD'],
        (nextEvents) => events.push(...nextEvents.map((event) => event.path)),
        (error) => {
          throw error
        }
      )
      const logs = join(root, 'logs')
      await mkdir(logs)
      await vi.advanceTimersByTimeAsync(30_000)
      await vi.waitFor(() => expect(watcherState.has(logs)).toBe(true))

      expect(events).toContain(join(logs, 'HEAD'))
    } finally {
      await subscription?.unsubscribe()
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })
})
