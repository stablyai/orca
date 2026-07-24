import { describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'
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
})
