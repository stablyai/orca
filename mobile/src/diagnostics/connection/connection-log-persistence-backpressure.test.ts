import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'
import type { ConnectionLogEntry } from './connection-log-types'

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

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.clearAllTimers()
    vi.useRealTimers()
  }
})

describe('connection log persistence backpressure', () => {
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
    expect(attempted).toEqual([['1'], ['2', '3']])
  })
})
