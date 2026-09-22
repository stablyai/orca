import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
  const actual = await vi.importActual('node:fs')
  return {
    ...actual,
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

import { startShallowWatcher } from './parcel-watcher-shallow-subscription'

function emit(path: string, fileName: string): void {
  watcherState.get(path)?.callback('change', fileName)
}

describe('shallow watcher subscription', () => {
  beforeEach(() => {
    watcherState.clear()
  })

  it('emits only included primary files, including an existing nested directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      await mkdir(join(root, 'logs'))
      const events: string[] = []
      const { promise, resolve } = Promise.withResolvers<void>()
      const subscription = startShallowWatcher(
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

      emit(root, 'config')
      emit(join(root, 'logs'), 'HEAD')
      await promise

      expect(events).toContain(join(root, 'config'))
      expect(events).toContain(join(root, 'logs', 'HEAD'))
      expect(events).not.toContain(join(root, 'unrelated'))
      await subscription.unsubscribe()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not forward events after unsubscribe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      const events: string[] = []
      const subscription = startShallowWatcher(
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

  it('rebinds a nested directory that is replaced, which leaves fs.watch deaf', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      await mkdir(join(root, 'logs'))
      const events: string[] = []
      const subscription = startShallowWatcher(
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

  it('reuses the nested binding for an ordinary change event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-shallow-watcher-'))
    try {
      await mkdir(join(root, 'logs'))
      const subscription = startShallowWatcher(
        root,
        ['logs/HEAD'],
        () => {},
        (error) => {
          throw error
        }
      )
      const firstNested = watcherState.get(join(root, 'logs'))?.watcher
      watcherState.get(root)?.callback('change', 'logs')
      expect(watcherState.get(join(root, 'logs'))?.watcher).toBe(firstNested)
      await subscription.unsubscribe()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
