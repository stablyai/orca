import { describe, expect, it, vi } from 'vitest'
import { dropSharedHostListLoad, getHostListLoadRevision } from './host-list-load-sharing'
import { loadHostClientOpenProfile } from './host-client-open-profile'
import { HostReconnectProfileCache } from './host-reconnect-profile-cache'
import type { HostClientOpenTicket } from './host-client-open-registry'
import type { HostProfile } from './types'

const HOST: HostProfile = {
  id: 'host-1',
  name: 'Host 1',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key',
  lastConnected: 0
}

describe('host client open profile', () => {
  it('returns the exact durable revision that produced the loaded profile', async () => {
    dropSharedHostListLoad()
    const ticket: HostClientOpenTicket = {
      cancelled: false,
      profileVersion: 0,
      promise: Promise.resolve()
    }

    const profile = await loadHostClientOpenProfile({
      hostId: HOST.id,
      cache: new HostReconnectProfileCache(),
      ticket,
      loadHosts: vi.fn(async () => [HOST]),
      onUnavailable: vi.fn()
    })

    expect(profile?.sourceRevision).toBe(getHostListLoadRevision())
    dropSharedHostListLoad()
    expect(profile?.sourceRevision).not.toBe(getHostListLoadRevision())
  })
})
