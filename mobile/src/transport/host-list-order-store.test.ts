import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoredHostProfile } from './types'

const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), invalidate: vi.fn() }))
vi.mock('./host-metadata-store', () => ({
  readStoredHostProfilesForMutation: storage.read,
  writeStoredHostProfiles: storage.write
}))
vi.mock('./host-list-load-sharing', () => ({ dropSharedHostListLoad: storage.invalidate }))

import { reorderHosts } from './host-list-order-store'
import { mutateStoredHosts, resetHostListMutationQueueForTests } from './host-list-mutation-queue'

const first = {
  id: 'a',
  name: 'First',
  endpoint: 'ws://127.0.0.1:1',
  publicKeyB64: 'fixture-a',
  lastConnected: 0
}
const second = {
  id: 'b',
  name: 'Second',
  endpoint: 'ws://127.0.0.1:2',
  publicKeyB64: 'fixture-b',
  lastConnected: 100
}
let saved: StoredHostProfile[]
beforeEach(() => {
  vi.clearAllMocks()
  resetHostListMutationQueueForTests()
  saved = [first, second]
  storage.read.mockImplementation(async () => saved)
  storage.write.mockImplementation(async (next: StoredHostProfile[]) => {
    saved = next
  })
})

describe('durable desktop order', () => {
  it('persists the requested order without replacing metadata objects', async () => {
    await reorderHosts(['b', 'a'])
    expect(saved).toEqual([second, first])
    expect(saved[0]).toBe(second)
    expect(storage.invalidate).toHaveBeenCalledOnce()
  })

  it('preserves simultaneous metadata writes under the shared queue', async () => {
    await Promise.all([
      mutateStoredHosts((hosts) =>
        hosts.map((host) => (host.id === 'b' ? { ...host, personalName: 'Renamed' } : host))
      ),
      mutateStoredHosts((hosts) =>
        hosts.map((host) => (host.id === 'a' ? { ...host, lastConnected: 500 } : host))
      ),
      reorderHosts(['b', 'a'])
    ])
    expect(saved.map((host) => host.id)).toEqual(['b', 'a'])
    expect(saved[0]?.personalName).toBe('Renamed')
    expect(saved[1]?.lastConnected).toBe(500)
  })

  it('preserves new hosts and ignores removed or duplicated ids from a stale drag', async () => {
    const added = { ...first, id: 'new-host', publicKeyB64: 'new-key' }
    saved = [first, added, second]
    await reorderHosts(['removed-host', 'b', 'b', 'a'])
    expect(saved).toEqual([second, first, added])
  })

  it('does not write or invalidate for an unchanged order', async () => {
    await reorderHosts(['a', 'b'])
    expect(storage.write).not.toHaveBeenCalled()
    expect(storage.invalidate).not.toHaveBeenCalled()
  })

  it('reports a failed read without overwriting the list and permits a later retry', async () => {
    storage.read.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(reorderHosts(['b', 'a'])).rejects.toThrow('storage unavailable')
    expect(saved).toEqual([first, second])
    expect(storage.write).not.toHaveBeenCalled()
    await reorderHosts(['b', 'a'])
    expect(saved).toEqual([second, first])
  })
})
