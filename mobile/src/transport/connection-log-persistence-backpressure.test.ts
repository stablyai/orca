import { describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'
import type { ConnectionLogEntry } from './types'

const entry = (id: number): ConnectionLogEntry => ({
  id: String(id),
  ts: id,
  level: 'info',
  message: `event ${id}`
})

async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await Promise.resolve()
  }
}

describe('connection log persistence backpressure', () => {
  it('writes only the latest pending snapshot when storage falls behind', async () => {
    const saved: string[][] = []
    let release: () => void = () => {}
    let delay = false
    const store = createConnectionLogStore(200, {
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
    await drainMicrotasks()
    saved.length = 0
    delay = true
    store.append('a', entry(0))
    await drainMicrotasks()
    for (let i = 1; i <= 1000; i++) {
      store.append('a', entry(i))
      await drainMicrotasks()
    }
    expect(saved).toEqual([['0']])
    release()
    for (let i = 0; i < 1000; i++) {
      await drainMicrotasks()
    }
    expect(saved).toHaveLength(2)
    expect(saved[1]).toEqual(store.get('a').map((item) => item.id))
  })

  it('persists a different host while one host has a stalled save', async () => {
    const saved: [string, string[]][] = []
    let release: () => void = () => {}
    let delay = false
    const store = createConnectionLogStore(200, {
      load: async () => [],
      save: async (host, entries) => {
        saved.push([host, entries.map((item) => item.id)])
        if (delay && host === 'a') {
          delay = false
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
      }
    })
    await Promise.all(['a', 'b'].map((host) => store.hydrate(host)))
    await drainMicrotasks()
    saved.length = 0
    delay = true
    store.append('a', entry(1))
    await drainMicrotasks()
    store.append('a', entry(2))
    store.append('b', entry(3))
    await drainMicrotasks()
    expect(saved).toEqual([
      ['a', ['1']],
      ['b', ['3']]
    ])
    release()
    await drainMicrotasks()
    expect(saved.at(-1)).toEqual(['a', ['1', '2']])
  })

  it('saves the latest snapshot after an older in-flight revision fails', async () => {
    let rejectSave: (error: Error) => void = () => {}
    let failing = false
    let persisted: readonly ConnectionLogEntry[] = []
    const saved: string[][] = []
    const persistence = {
      load: async () => persisted,
      save: async (_host: string, entries: readonly ConnectionLogEntry[]) => {
        saved.push(entries.map((item) => item.id))
        if (failing && entries.length === 1) {
          if (saved.length === 1) {
            await new Promise<void>((_resolve, reject) => {
              rejectSave = reject
            })
          }
          throw new Error('storage unavailable')
        }
        persisted = entries
      }
    }
    const store = createConnectionLogStore(2, persistence)
    await store.hydrate('a')
    await drainMicrotasks()
    saved.length = 0
    failing = true
    store.append('a', entry(1))
    await drainMicrotasks()
    store.append('a', entry(2))
    await drainMicrotasks()
    store.append('a', entry(3))
    await drainMicrotasks()
    rejectSave(new Error('storage unavailable'))
    await drainMicrotasks()
    expect(saved).toEqual([['1'], ['2', '3']])
    const reloaded = createConnectionLogStore(2, persistence)
    await reloaded.hydrate('a')
    expect(reloaded.get('a')).toEqual(store.get('a'))
  })

  it.each([false, true])(
    'includes an append during save settlement (deferred=%s)',
    async (deferred) => {
      let afterSave = () => {}
      const saved: string[][] = []
      const store = createConnectionLogStore(200, {
        load: async () => [],
        save: async (_host, entries) => {
          saved.push(entries.map((item) => item.id))
          afterSave()
        }
      })
      await store.hydrate('a')
      await drainMicrotasks()
      saved.length = 0
      afterSave = () => {
        afterSave = () => {}
        if (deferred) {
          queueMicrotask(() => store.append('a', entry(2)))
        } else {
          store.append('a', entry(2))
        }
      }
      store.append('a', entry(1))
      await drainMicrotasks()
      expect(saved).toEqual([['1'], ['1', '2']])
    }
  )

  it('attempts the newest snapshot instead of replaying superseded ones', async () => {
    let release: () => void = () => {}
    let hold = false
    let failing = false
    const attempted: string[][] = []
    const store = createConnectionLogStore(2, {
      load: async () => [],
      save: async (_host, entries) => {
        attempted.push(entries.map((item) => item.id))
        if (hold) {
          hold = false
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        if (failing) {
          throw new Error('storage temporarily unavailable')
        }
      }
    })
    await store.hydrate('a')
    await drainMicrotasks()
    attempted.length = 0
    hold = true
    failing = true
    for (let i = 1; i <= 3; i++) {
      store.append('a', entry(i))
      await drainMicrotasks()
    }
    expect(attempted).toEqual([['1']])
    release()
    await drainMicrotasks()
    // The superseded ['1'] snapshot is never replayed; only the newest one is attempted.
    expect(attempted).toEqual([['1'], ['2', '3']])
  })

  it('bounds writes when a long stall unblocks against failing storage', async () => {
    vi.useFakeTimers()
    try {
      let release: () => void = () => {}
      let hold = false
      let failing = false
      let writes = 0
      const store = createConnectionLogStore(200, {
        load: async () => [],
        save: async () => {
          writes += 1
          if (hold) {
            hold = false
            await new Promise<void>((resolve) => {
              release = resolve
            })
          }
          if (failing) {
            throw new Error('storage unavailable')
          }
        }
      })
      await store.hydrate('a')
      await drainMicrotasks()
      writes = 0
      hold = true
      failing = true
      for (let i = 0; i < 500; i++) {
        store.append('a', entry(i))
        await drainMicrotasks()
      }
      expect(writes).toBe(1)
      release()
      for (let i = 0; i < 20; i++) {
        await drainMicrotasks()
      }
      // 500 stalled appends cost the held write plus one attempt at the newest snapshot.
      expect(writes).toBe(2)
      await vi.advanceTimersByTimeAsync(5_000)
      // Draining the backoff adds that snapshot's single retry and nothing more.
      expect(writes).toBe(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('flush persists the newest snapshot after a failed save and a quiet log', async () => {
    let failing = true
    let durableIds: string[] = []
    let writes = 0
    const store = createConnectionLogStore(200, {
      load: async () => [],
      save: async (_host, entries) => {
        writes += 1
        if (failing) {
          throw new Error('storage unavailable')
        }
        durableIds = entries.map((item) => item.id)
      }
    })
    await store.hydrate('a')
    await drainMicrotasks()
    store.append('a', entry(1))
    store.append('a', entry(2))
    await drainMicrotasks()
    expect(durableIds).toEqual([])
    failing = false
    writes = 0
    await store.flush()
    expect(durableIds).toEqual(['1', '2'])
    expect(writes).toBe(1)
    await store.flush()
    expect(writes).toBe(1)
  })
})
