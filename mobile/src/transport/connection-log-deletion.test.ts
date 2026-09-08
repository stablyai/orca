import { describe, expect, it, vi } from 'vitest'
import { createConnectionLogStore } from './connection-log-buffer'
import type { ConnectionLogEntry } from './types'

function entry(id: string): ConnectionLogEntry {
  return { id, ts: 1, level: 'info', message: id }
}

describe('connection log deletion', () => {
  it('fences an in-flight hydration without losing new entries for a re-paired host', async () => {
    const loaded = Promise.withResolvers<readonly ConnectionLogEntry[]>()
    const load = vi.fn(() => loaded.promise)
    const save = vi.fn(async (_hostId: string, _entries: readonly ConnectionLogEntry[]) => {})
    const store = createConnectionLogStore(200, { load, save })
    store.append('host', entry('before removal'))
    const hydration = store.hydrate('host')

    store.delete('host')
    expect(store.get('host')).toEqual([])
    store.append('host', entry('after re-pair'))
    loaded.resolve([entry('persisted history')])
    await hydration

    expect(store.get('host')).toEqual([entry('after re-pair')])
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith('host', [entry('after re-pair')]))
    expect(load).toHaveBeenCalledOnce()
    expect(
      save.mock.calls.every(([, entries]) => !entries.some(({ id }) => id === 'persisted history'))
    ).toBe(true)
  })

  it('clears disk after an in-flight save and discards older queued snapshots', async () => {
    const firstSave = Promise.withResolvers<void>()
    let persisted: readonly ConnectionLogEntry[] = []
    const save = vi.fn(async (_hostId: string, entries: readonly ConnectionLogEntry[]) => {
      if (save.mock.calls.length === 1) {
        await firstSave.promise
      }
      persisted = entries
    })
    const store = createConnectionLogStore(200, { load: async () => [], save })
    store.append('host', entry('old'))
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce())
    store.append('host', entry('queued'))
    await Promise.resolve()

    store.delete('host')
    firstSave.resolve()
    await vi.waitFor(() => expect(save).toHaveBeenLastCalledWith('host', []))

    expect(persisted).toEqual([])
    expect(store.get('host')).toEqual([])
    expect(save.mock.calls.slice(1).every(([, entries]) => entries.length === 0)).toBe(true)
  })

  it('keeps another host intact and publishes the cleared snapshot once', () => {
    const store = createConnectionLogStore()
    store.append('host', entry('removed'))
    store.append('other', entry('retained'))
    const removedListener = vi.fn()
    const otherListener = vi.fn()
    store.subscribe('host', removedListener)
    store.subscribe('other', otherListener)

    store.delete('host')

    expect(store.get('host')).toEqual([])
    expect(store.get('other')).toEqual([entry('retained')])
    expect(removedListener).toHaveBeenCalledOnce()
    expect(otherListener).not.toHaveBeenCalled()
  })
})
