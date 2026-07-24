import { describe, expect, it, vi } from 'vitest'
import { CONNECTION_LOG_HOST_ID_MAX_BYTES, createConnectionLogStore } from './connection-log-buffer'
import type { ConnectionLogEntry } from './types'

function entry(id: number): ConnectionLogEntry {
  return { id: `log-${id}`, ts: 1_000 + id, level: 'info', message: `event ${id}` }
}

describe('connection log buffer', () => {
  it('keeps entries per host without cross-talk', () => {
    const store = createConnectionLogStore()
    store.append('host-a', entry(1))
    store.append('host-b', entry(2))

    expect(store.get('host-a').map((e) => e.id)).toEqual(['log-1'])
    expect(store.get('host-b').map((e) => e.id)).toEqual(['log-2'])
  })

  it('drops the oldest entries past the cap', () => {
    const store = createConnectionLogStore(3)
    for (let i = 1; i <= 5; i++) {
      store.append('host-a', entry(i))
    }

    expect(store.get('host-a').map((e) => e.id)).toEqual(['log-3', 'log-4', 'log-5'])
  })

  it('returns a stable snapshot reference until the next append', () => {
    const store = createConnectionLogStore()
    store.append('host-a', entry(1))

    const first = store.get('host-a')
    expect(store.get('host-a')).toBe(first)

    store.append('host-a', entry(2))
    expect(store.get('host-a')).not.toBe(first)
    // Empty hosts must also be referentially stable (useSyncExternalStore).
    expect(store.get('host-b')).toBe(store.get('host-b'))
  })

  it('notifies only the host being appended to and stops after unsubscribe', () => {
    const store = createConnectionLogStore()
    const onA = vi.fn()
    const onB = vi.fn()
    const unsubA = store.subscribe('host-a', onA)
    store.subscribe('host-b', onB)

    store.append('host-a', entry(1))
    expect(onA).toHaveBeenCalledTimes(1)
    expect(onB).not.toHaveBeenCalled()

    unsubA()
    store.append('host-a', entry(2))
    expect(onA).toHaveBeenCalledTimes(1)
  })

  it('evicts the least-recently-written inactive host past the host cap', () => {
    const store = createConnectionLogStore(3, 2)
    store.append('host-a', entry(1))
    store.append('host-b', entry(2))
    store.append('host-a', entry(3))
    store.append('host-c', entry(4))

    expect(store.get('host-a').map((e) => e.id)).toEqual(['log-1', 'log-3'])
    expect(store.get('host-b')).toEqual([])
    expect(store.get('host-c').map((e) => e.id)).toEqual(['log-4'])
  })

  it('drops removed-host entries and refreshes an active snapshot', () => {
    const store = createConnectionLogStore()
    const listener = vi.fn()
    store.append('host-a', entry(1))
    store.subscribe('host-a', listener)

    store.delete('host-a')

    expect(store.get('host-a')).toEqual([])
    expect(listener).toHaveBeenCalledOnce()
  })

  it('accepts the exact host-id limit and rejects one more byte', () => {
    const store = createConnectionLogStore()
    const exactHost = 'h'.repeat(CONNECTION_LOG_HOST_ID_MAX_BYTES)

    store.append(exactHost, entry(1))
    store.append(`${exactHost}h`, entry(2))

    expect(store.get(exactHost).map((value) => value.id)).toEqual(['log-1'])
    expect(store.get(`${exactHost}h`)).toEqual([])
  })

  it('accepts an exact entry-byte budget and rejects one more byte', () => {
    const store = createConnectionLogStore(10, 10, {
      maxEntryBytes: 260,
      maxHostBytes: 1024,
      maxStoreBytes: 2048
    })
    const exact: ConnectionLogEntry = { id: '', ts: 1, level: 'info', message: '' }

    store.append('host-a', exact)
    store.append('host-a', { ...exact, message: 'x' })

    expect(store.get('host-a')).toEqual([exact])
  })

  it('keeps newest entries within the per-host byte budget', () => {
    const store = createConnectionLogStore(10, 10, {
      maxEntryBytes: 1024,
      maxHostBytes: 700,
      maxStoreBytes: 4096
    })

    store.append('host-a', entry(1))
    store.append('host-a', entry(2))
    store.append('host-a', entry(3))

    expect(store.get('host-a').map((value) => value.id)).toEqual(['log-2', 'log-3'])
  })

  it('evicts inactive hosts to stay within the aggregate byte budget', () => {
    const store = createConnectionLogStore(10, 10, {
      maxEntryBytes: 1024,
      maxHostBytes: 1024,
      maxStoreBytes: 700
    })

    store.append('host-a', entry(1))
    store.append('host-b', entry(2))

    expect(store.get('host-a')).toEqual([])
    expect(store.get('host-b').map((value) => value.id)).toEqual(['log-2'])
  })
})
