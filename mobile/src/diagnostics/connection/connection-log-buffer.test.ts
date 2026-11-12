import { describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'
import type { ConnectionLogEntry } from './connection-log-types'

function entry(id: number): ConnectionLogEntry {
  return { id: `log-${id}`, ts: 1_000 + id, level: 'info', message: `event ${id}` }
}

describe('connection log buffer', () => {
  it('clears retained history without a pending hydration restoring it', async () => {
    let resolveLoad: (entries: readonly ConnectionLogEntry[]) => void = () => {}
    let persisted: readonly ConnectionLogEntry[] = [entry(1)]
    const store = createConnectionLogStore(3, {
      load: () =>
        new Promise((resolve) => {
          resolveLoad = resolve
        }),
      save: async (_hostId, entries) => {
        persisted = entries
      }
    })
    const hydration = store.hydrate('host-a')
    store.append('host-a', entry(2))

    await store.clear('host-a')
    resolveLoad([entry(1)])
    await hydration
    await store.flush()

    expect(store.get('host-a')).toEqual([])
    expect(persisted).toEqual([])
  })

  it('clears history after an older in-flight save finishes', async () => {
    let finishSave: () => void = () => {}
    let markSaveStarted: () => void = () => {}
    const saveStarted = new Promise<void>((resolve) => {
      markSaveStarted = resolve
    })
    let persisted: readonly ConnectionLogEntry[] = []
    let holdNextSave = false
    const store = createConnectionLogStore(3, {
      load: async () => [],
      save: async (_hostId, entries) => {
        if (holdNextSave) {
          holdNextSave = false
          markSaveStarted()
          await new Promise<void>((resolve) => {
            finishSave = resolve
          })
        }
        persisted = entries
      }
    })
    await store.hydrate('host-a')
    await store.flush()
    holdNextSave = true
    store.append('host-a', entry(1))
    await saveStarted

    const cleared = store.clear('host-a')
    finishSave()
    await cleared

    expect(store.get('host-a')).toEqual([])
    expect(persisted).toEqual([])
  })

  it('redacts credentials before retaining or persisting an event', async () => {
    const save = vi.fn(async () => {})
    const store = createConnectionLogStore(3, {
      load: async () => [{ ...entry(0), detail: 'authorization=Bearer legacy-secret' }],
      save
    })

    store.append('host-a', {
      ...entry(1),
      detail: 'resumeToken=do-not-copy deviceToken:also-secret'
    })
    expect(store.get('host-a')[0]?.detail).toBe('resumeToken=[redacted] deviceToken:[redacted]')
    await store.hydrate('host-a')

    expect(store.get('host-a').map((event) => event.detail)).toEqual([
      'authorization=[redacted]',
      'resumeToken=[redacted] deviceToken:[redacted]'
    ])
    await vi.waitFor(() => expect(save).toHaveBeenCalled())
    expect(JSON.stringify(save.mock.calls)).not.toContain('do-not-copy')
    expect(JSON.stringify(save.mock.calls)).not.toContain('also-secret')
    expect(JSON.stringify(save.mock.calls)).not.toContain('legacy-secret')
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
})
