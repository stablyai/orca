import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'

import type { ConnectionLogEntry } from './connection-log-types'

const entry = (id: number): ConnectionLogEntry => ({
  id: `${id}`,
  ts: id,
  level: 'info',
  message: `event ${id}`
})
const drain = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('connection log persistence revisions', () => {
  it('replaces obsolete queued revisions while a save is delayed', async () => {
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
    expect(saved).toEqual([['1'], ['2', '3']])
  })
})
