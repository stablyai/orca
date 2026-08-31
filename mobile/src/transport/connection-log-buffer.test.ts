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

  it('hydrates persisted history without dropping events recorded during app startup', async () => {
    let finishLoad: (entries: readonly ConnectionLogEntry[]) => void = () => {}
    const load = vi.fn(
      () =>
        new Promise<readonly ConnectionLogEntry[]>((resolve) => {
          finishLoad = resolve
        })
    )
    const save = vi.fn(async () => {})
    const store = createConnectionLogStore(3, { load, save })

    store.append('host-a', entry(3))
    finishLoad([entry(1), entry(2)])
    await store.hydrate('host-a')

    expect(store.get('host-a').map((e) => e.id)).toEqual(['log-1', 'log-2', 'log-3'])
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    expect(save).toHaveBeenLastCalledWith('host-a', [entry(1), entry(2), entry(3)])
  })

  it('redacts credentials before retaining or persisting an event', async () => {
    const save = vi.fn(async () => {})
    const store = createConnectionLogStore(3, { load: async () => [], save })

    store.append('host-a', {
      ...entry(1),
      detail: 'resumeToken=do-not-copy deviceToken:also-secret'
    })
    await store.hydrate('host-a')

    expect(store.get('host-a')[0]?.detail).toBe('resumeToken=[redacted] deviceToken:[redacted]')
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    expect(JSON.stringify(save.mock.calls)).not.toContain('do-not-copy')
    expect(JSON.stringify(save.mock.calls)).not.toContain('also-secret')
  })

  it('redacts quoted credential values when the object key is unquoted', async () => {
    const store = createConnectionLogStore(3, { load: async () => [], save: async () => {} })

    store.append('host-a', {
      ...entry(1),
      detail: `resumeToken: 'secret-one' deviceToken="secret-two"`
    })
    await store.hydrate('host-a')

    expect(store.get('host-a')[0]?.detail).toBe(
      `resumeToken: '[redacted]' deviceToken="[redacted]"`
    )
  })

  it('redacts the full quoted credential when its value contains an escaped quote', async () => {
    const store = createConnectionLogStore(3, { load: async () => [], save: async () => {} })

    store.append('host-a', {
      ...entry(1),
      detail: String.raw`{"token":"secret\"tail"} token: 'secret\'tail'`
    })
    await store.hydrate('host-a')

    expect(store.get('host-a')[0]?.detail).toBe(`{"token":"[redacted]"} token: '[redacted]'`)
  })

  it('redacts unterminated quoted credentials', async () => {
    const store = createConnectionLogStore(3, { load: async () => [], save: async () => {} })

    store.append('host-a', {
      ...entry(1),
      message: 'token="secret',
      detail: '{"authorization":"Bearer also-secret'
    })
    await store.hydrate('host-a')

    expect(store.get('host-a')[0]).toMatchObject({
      message: 'token="[redacted]',
      detail: '{"authorization":"[redacted]'
    })
  })

  it('redacts URL userinfo through the last authority separator', async () => {
    const store = createConnectionLogStore(3, { load: async () => [], save: async () => {} })

    store.append('host-a', {
      ...entry(1),
      message: 'wss://user:p@ss@example.com/x',
      detail: 'https://user:pass@example.com/x'
    })
    await store.hydrate('host-a')

    expect(store.get('host-a')[0]).toMatchObject({
      message: 'wss://[redacted]@example.com/x',
      detail: 'https://[redacted]@example.com/x'
    })
  })

  it('does not overwrite persisted history when hydration fails and retries later', async () => {
    const load = vi
      .fn<() => Promise<readonly ConnectionLogEntry[]>>()
      .mockRejectedValueOnce(new Error('storage unavailable'))
      .mockResolvedValueOnce([entry(1)])
    const save = vi.fn(async () => {})
    const store = createConnectionLogStore(3, { load, save })

    store.append('host-a', entry(2))
    await expect(store.hydrate('host-a')).rejects.toThrow('storage unavailable')
    expect(save).not.toHaveBeenCalled()

    await store.hydrate('host-a')
    expect(store.get('host-a').map((value) => value.id)).toEqual(['log-1', 'log-2'])
  })

  it('preserves legacy entries that reused the same event id', async () => {
    const store = createConnectionLogStore(3, {
      load: async () => [entry(1), { ...entry(2), id: 'log-1' }],
      save: async () => {}
    })

    await store.hydrate('host-a')

    expect(store.get('host-a').map((value) => value.message)).toEqual(['event 1', 'event 2'])
  })

  it('retries one transient persistence failure without requiring another append', async () => {
    const save = vi.fn().mockResolvedValue(undefined)
    const store = createConnectionLogStore(3, { load: async () => [], save })

    await store.hydrate('host-a')
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    save.mockReset()
    save.mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValueOnce(undefined)
    store.append('host-a', entry(1))

    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save).toHaveBeenLastCalledWith('host-a', [entry(1)])
  })

  it('does not retry failed automatic hydration for every appended event', async () => {
    const load = vi.fn().mockRejectedValue(new Error('storage unavailable'))
    const store = createConnectionLogStore(3, { load, save: async () => {} })

    store.append('host-a', entry(1))
    await expect(store.hydrate('host-a')).rejects.toThrow('storage unavailable')
    store.append('host-a', entry(2))
    store.append('host-a', entry(3))
    await Promise.resolve()

    expect(load).toHaveBeenCalledTimes(1)
    await expect(store.hydrate('host-a')).rejects.toThrow('storage unavailable')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
