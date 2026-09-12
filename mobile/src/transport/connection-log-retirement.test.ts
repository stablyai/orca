import { describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'
import type { ConnectionLogEntry } from './types'

function entry(id: number): ConnectionLogEntry {
  return { id: `log-${id}`, ts: id, level: 'info', message: `event ${id}` }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('connection log retirement', () => {
  it('empties the removed host, notifies its subscribers and preserves other hosts', async () => {
    const store = createConnectionLogStore()
    const onA = vi.fn()
    const onB = vi.fn()
    const unsubscribe = store.subscribe('a', onA)
    store.subscribe('b', onB)
    store.append('a', entry(1))
    store.append('b', entry(2))
    expect(store.get('a')).toEqual([entry(1)])
    const otherSnapshot = store.get('b')
    onA.mockClear()
    onB.mockClear()

    await store.forgetHost('a')

    expect(store.get('a')).toEqual([])
    expect(store.get('a')).toBe(store.get('missing'))
    expect(onA).toHaveBeenCalledOnce()
    expect(onB).not.toHaveBeenCalled()
    expect(store.get('b')).toBe(otherSnapshot)
    expect(store.get('b')).toEqual([entry(2)])
    unsubscribe()
    store.append('a', entry(3))
    expect(onA).toHaveBeenCalledOnce()
    expect(store.get('a')).toEqual([entry(3)])
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a retired hydration that later %ss',
    async (settle) => {
      const oldLoad = deferred<readonly ConnectionLogEntry[]>()
      const load = vi.fn().mockReturnValueOnce(oldLoad.promise).mockResolvedValue([])
      const save = vi.fn(async (_id: string, _entries: readonly ConnectionLogEntry[]) => {})
      const remove = vi.fn(async () => {})
      const store = createConnectionLogStore(200, { load, save, remove })
      store.append('a', entry(1))
      const oldHydration = store.hydrate('a').catch(() => {})
      await store.forgetHost('a')
      const listener = vi.fn()
      store.subscribe('a', listener)
      if (settle === 'resolve') {
        oldLoad.resolve([entry(0)])
      } else {
        oldLoad.reject(new Error('old load failed'))
      }
      await oldHydration

      expect(store.get('a')).toEqual([])
      expect(listener).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      store.append('a', entry(2))
      await store.hydrate('a')
      expect(load).toHaveBeenCalledTimes(2)
      expect(store.get('a')).toEqual([entry(2)])
    }
  )

  it.each(['resolve', 'reject'] as const)(
    'does not disturb re-pairing when a prior hydration %ss',
    async (settle) => {
      const oldLoad = deferred<readonly ConnectionLogEntry[]>()
      const newLoad = deferred<readonly ConnectionLogEntry[]>()
      const load = vi.fn().mockReturnValueOnce(oldLoad.promise).mockReturnValueOnce(newLoad.promise)
      const store = createConnectionLogStore(200, {
        load,
        save: async () => {},
        remove: async () => {}
      })
      store.append('a', entry(1))
      const oldHydration = store.hydrate('a').catch(() => {})
      await store.forgetHost('a')
      store.append('a', entry(2))
      const newHydration = store.hydrate('a')
      if (settle === 'resolve') {
        oldLoad.resolve([entry(0)])
      } else {
        oldLoad.reject(new Error('old load failed'))
      }
      await oldHydration
      store.append('a', entry(3))
      expect(load).toHaveBeenCalledTimes(2)
      newLoad.resolve([])
      await newHydration

      expect(store.get('a')).toEqual([entry(2), entry(3)])
    }
  )

  it('orders removal after an in-flight save and before a new lifecycle loads', async () => {
    const saved = new Map<string, readonly ConnectionLogEntry[]>()
    const firstSave = deferred<void>()
    const saveStarted = deferred<void>()
    const events: string[] = []
    let shouldBlock = true
    const store = createConnectionLogStore(200, {
      load: async (id) => {
        events.push('load')
        return saved.get(id) ?? []
      },
      save: async (id, entries) => {
        events.push(`save:${entries.map((e) => e.id).join(',')}`)
        if (shouldBlock) {
          shouldBlock = false
          saveStarted.resolve()
          await firstSave.promise
        }
        saved.set(id, entries)
      },
      remove: async (id) => {
        events.push('remove')
        saved.delete(id)
      }
    })
    store.append('a', entry(1))
    await saveStarted.promise
    store.append('a', entry(2))
    const removal = store.forgetHost('a')
    store.append('a', entry(3))
    const hydration = store.hydrate('a')
    expect(events).toEqual(['load', 'save:log-1'])
    firstSave.resolve()
    await removal
    await hydration
    await vi.waitFor(() => expect(saved.get('a')).toEqual([entry(3)]))

    expect(store.get('a')).toEqual([entry(3)])
    expect(events.slice(0, 4)).toEqual(['load', 'save:log-1', 'remove', 'load'])
    expect(events).not.toContain('save:log-1,log-2')
  })

  it('can retire again while the first removal is pending', async () => {
    const firstRemoval = deferred<void>()
    const remove = vi.fn().mockReturnValueOnce(firstRemoval.promise).mockResolvedValue(undefined)
    const save = vi.fn(async (_id: string, _entries: readonly ConnectionLogEntry[]) => {})
    const store = createConnectionLogStore(200, { load: async () => [], save, remove })
    const first = store.forgetHost('a')
    store.append('a', entry(1))
    const intermediate = store.hydrate('a')
    const second = store.forgetHost('a')
    store.append('a', entry(2))
    firstRemoval.resolve()
    await Promise.all([first, intermediate, second, store.hydrate('a')])
    await vi.waitFor(() => expect(save).toHaveBeenCalled())

    expect(remove).toHaveBeenCalledTimes(2)
    expect(store.get('a')).toEqual([entry(2)])
    expect(save.mock.calls.every(([, entries]) => entries.every((e) => e.id === 'log-2'))).toBe(
      true
    )
  })

  it('retries a failed removal once and leaves a forgotten log empty on failure', async () => {
    const remove = vi.fn().mockRejectedValue(new Error('storage unavailable'))
    const store = createConnectionLogStore(200, {
      load: async () => [],
      save: async () => {},
      remove
    })
    store.append('a', entry(1))
    await expect(store.forgetHost('a')).rejects.toThrow('storage unavailable')
    expect(remove).toHaveBeenCalledTimes(2)
    expect(store.get('a')).toEqual([])
  })
})
