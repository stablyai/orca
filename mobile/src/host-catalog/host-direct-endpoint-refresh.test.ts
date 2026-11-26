import { describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value))
  }
}))

import { directEndpointCandidate } from './host-direct-endpoint-refresh'
import {
  adoptHostDirectEndpoint,
  markHostDirectEndpointListed
} from './host-direct-endpoint-persistence'
import { loadStoredHostProfiles, writeStoredHostProfiles } from './host-metadata-store'

const LAN = 'ws://192.168.1.5:6768'
const MOVED_LAN = 'ws://192.168.1.9:6768'
const TAILNET = 'ws://100.101.1.2:6768'

describe('following a desktop direct endpoint', () => {
  it('offers only a same-kind replacement for an address the desktop no longer lists', () => {
    const host = { endpoint: LAN, directEndpointOrigin: 'host' as const }
    expect(directEndpointCandidate(host, [TAILNET, MOVED_LAN])).toBe(MOVED_LAN)
    // A VPN or second NIC listed first must not win over the address in the old subnet.
    expect(directEndpointCandidate(host, ['ws://10.8.0.5:6768', MOVED_LAN])).toBe(MOVED_LAN)
    // Still listed: keep it even though the desktop now prefers Tailscale.
    expect(directEndpointCandidate(host, [TAILNET, LAN])).toBeNull()
    // Tailscale gone for a moment must not move a tailnet row onto LAN.
    expect(
      directEndpointCandidate({ endpoint: TAILNET, directEndpointOrigin: 'host' }, [LAN])
    ).toBeNull()
    // Unknown origin may be a tunnel or a pre-upgrade custom address.
    expect(directEndpointCandidate({ endpoint: LAN }, [MOVED_LAN])).toBeNull()
  })

  it('saves only over a desktop-owned endpoint, never one typed in Edit Host', async () => {
    await writeStoredHostProfiles([
      { id: 'h1', name: 'Desk', endpoint: LAN, publicKeyB64: 'pk', lastConnected: 1 }
    ])
    expect(await markHostDirectEndpointListed('h1', [TAILNET, LAN])).toEqual({
      endpoint: LAN,
      directEndpointOrigin: 'host'
    })
    expect(await adoptHostDirectEndpoint('h1', LAN, MOVED_LAN)).toEqual({
      endpoint: MOVED_LAN,
      directEndpointOrigin: 'host'
    })

    // Edit Host saved the very value the desktop moved it to: it is the user's from now on.
    await writeStoredHostProfiles([
      {
        id: 'h1',
        name: 'Desk',
        endpoint: MOVED_LAN,
        directEndpointOrigin: 'manual',
        publicKeyB64: 'pk',
        lastConnected: 1
      }
    ])
    await adoptHostDirectEndpoint('h1', MOVED_LAN, 'ws://192.168.1.20:6768')
    await markHostDirectEndpointListed('h1', [MOVED_LAN])
    expect(await loadStoredHostProfiles()).toEqual([
      expect.objectContaining({ endpoint: MOVED_LAN, directEndpointOrigin: 'manual' })
    ])
  })
})
