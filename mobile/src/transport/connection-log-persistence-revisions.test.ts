import { describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore, type ConnectionLogPersistence } from './connection-log-buffer'
import type { ConnectionLogEntry } from './types'

const entry = (id: number): ConnectionLogEntry => ({
  id: `${id}`,
  ts: id,
  level: 'info',
  message: `event ${id}`
})
const drain = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('connection log persistence revisions', () => {
  it('writes a synchronous burst once per host after hydration', async () => {
    const save = vi.fn<ConnectionLogPersistence['save']>(async () => {})
    const store = createConnectionLogStore(200, { load: async () => [], save })
    await Promise.all(['a', 'b'].map((host) => store.hydrate(host)))
    await drain()
    save.mockClear()
    for (let i = 0; i < 1000; i++) {
      store.append('a', entry(i))
      store.append('b', entry(i + 2000))
    }
    await drain()
    expect(save).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledWith('a', store.get('a'))
    expect(save).toHaveBeenCalledWith('b', store.get('b'))
  })

  it('shares one snapshot across startup appends waiting on hydration', async () => {
    let loaded!: (entries: ConnectionLogEntry[]) => void
    const save = vi.fn<ConnectionLogPersistence['save']>(async () => {})
    const store = createConnectionLogStore(200, {
      load: () =>
        new Promise((resolve) => {
          loaded = resolve
        }),
      save
    })
    for (let i = 1; i <= 100; i++) {
      store.append('a', entry(i))
    }
    loaded([entry(0)])
    await store.hydrate('a')
    await drain()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith(
      'a',
      Array.from({ length: 101 }, (_, i) => entry(i))
    )
  })

  it('preserves distinct queued revisions while a save is delayed', async () => {
    const saved: string[][] = []
    let release!: () => void
    let delay = false
    const store = createConnectionLogStore(2, {
      load: async () => [],
      save: async (_host, entries) => {
        saved.push(entries.map((item) => item.id))
        if (delay) {
          delay = false
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      }
    })
    await store.hydrate('a')
    await drain()
    saved.length = 0
    delay = true
    store.append('a', entry(1))
    await drain()
    store.append('a', entry(2))
    await drain()
    store.append('a', entry(3))
    await drain()
    expect(saved).toEqual([['1']])
    release()
    await drain()
    expect(saved).toEqual([['1'], ['1', '2'], ['2', '3']])
  })

  it('retains retries and later attempts when both initial save attempts fail', async () => {
    const save = vi.fn<ConnectionLogPersistence['save']>(async () => {})
    const store = createConnectionLogStore(200, { load: async () => [], save })
    await store.hydrate('a')
    await drain()
    save.mockClear()
    save.mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('retry'))
    store.append('a', entry(1))
    store.append('a', entry(2))
    store.append('a', entry(3))
    await drain()
    expect(save).toHaveBeenCalledTimes(3)
    expect(save.mock.calls[2]?.[1]).toBe(save.mock.calls[0]?.[1])
    for (const [, snapshot] of save.mock.calls) {
      expect(snapshot).toEqual([entry(1), entry(2), entry(3)])
    }
  })
  it('keeps every queued retry opportunity during a sustained failure', async () => {
    const save = vi.fn<ConnectionLogPersistence['save']>(async () => {})
    const store = createConnectionLogStore(200, { load: async () => [], save })
    await store.hydrate('a')
    await drain()
    save.mockReset().mockRejectedValue(new Error('unavailable'))
    for (let i = 0; i < 3; i++) {
      store.append('a', entry(i))
    }
    await drain()
    expect(save).toHaveBeenCalledTimes(6)
    save.mockClear().mockResolvedValue(undefined)
    store.append('a', entry(3))
    await drain()
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenLastCalledWith('a', store.get('a'))
  })
})
