import { describe, expect, it, vi } from 'vitest'

const storage = vi.hoisted(() => new Map<string, string>())
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => void storage.set(key, value))
  }
}))
// The full host store pulls in React Native; the follower only reads its settled-list cache.
vi.mock('./host-store', () => ({ peekHosts: () => undefined }))

import { directEndpointCandidates } from './host-direct-endpoint-refresh'
import { createHostDirectEndpointFollower } from '../transport/connection/host-direct-endpoint-follower'
import type { StableLogicalRpcClient } from '../transport/connection/stable-logical-rpc-client'
import { createFakeRpcClient } from '../mobile-web-shell/test-support/bridge-host-test-fakes'
import {
  adoptHostDirectEndpoint,
  markHostDirectEndpointListed
} from './host-direct-endpoint-persistence'
import { loadStoredHostProfiles, writeStoredHostProfiles } from './host-metadata-store'

const LAN = 'ws://192.168.1.5:6768'
const MOVED_LAN = 'ws://192.168.1.9:6768'
const TAILNET = 'ws://100.101.1.2:6768'

describe('following a desktop direct endpoint', () => {
  it('offers only same-kind replacements for an address the desktop no longer lists', () => {
    const host = { endpoint: LAN, directEndpointOrigin: 'host' as const }
    expect(directEndpointCandidates(host, [TAILNET, MOVED_LAN, MOVED_LAN])).toEqual([MOVED_LAN])
    // A VPN or second NIC listed first must not win over the address in the old subnet.
    expect(directEndpointCandidates(host, ['ws://10.8.0.5:6768', MOVED_LAN])).toEqual([
      MOVED_LAN,
      'ws://10.8.0.5:6768'
    ])
    // Still listed: keep it even though the desktop now prefers Tailscale.
    expect(directEndpointCandidates(host, [TAILNET, LAN])).toEqual([])
    // Tailscale gone for a moment must not move a tailnet row onto LAN.
    expect(
      directEndpointCandidates({ endpoint: TAILNET, directEndpointOrigin: 'host' }, [LAN])
    ).toEqual([])
    // Unknown origin may be a tunnel or a pre-upgrade custom address.
    expect(directEndpointCandidates({ endpoint: LAN }, [MOVED_LAN])).toEqual([])
  })

  it('works through the listed addresses past dead ones, across capped reads', async () => {
    await writeStoredHostProfiles([
      {
        id: 'h1',
        name: 'Desk',
        endpoint: LAN,
        directEndpointOrigin: 'host',
        publicKeyB64: 'pk',
        lastConnected: 1
      }
    ])
    const dead = ['ws://192.168.1.6:6768', 'ws://192.168.1.7:6768', 'ws://192.168.1.8:6768']
    const host = createFakeRpcClient()
    const dialed: string[] = []
    let now = 1_000
    const follower = createHostDirectEndpointFollower({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the follower only reads state and sends requests.
      client: host as unknown as StableLogicalRpcClient,
      hostId: 'h1',
      saved: { endpoint: LAN, directEndpointOrigin: 'host' },
      openDirect: (endpoint) => {
        dialed.push(endpoint)
        const direct = createFakeRpcClient({
          getState: () => (endpoint === MOVED_LAN ? 'connected' : 'connecting')
        })
        if (endpoint !== MOVED_LAN) {
          queueMicrotask(() => direct.pushState('disconnected'))
        }
        return direct
      },
      isForeground: () => true,
      now: () => now
    })
    const answer = async (read: number): Promise<void> => {
      await vi.waitFor(() => expect(host.requests).toHaveLength(read))
      host.requests[read - 1]!.resolve({
        id: String(read),
        ok: true,
        result: { v: 1, endpoints: [...dead, MOVED_LAN] }
      })
    }
    follower.onConnected()
    await answer(1)
    await vi.waitFor(() => expect(dialed).toEqual(dead))

    // Long after the misses aged out, the next read still starts with the address not tried yet.
    now += 10 * 60_000
    follower.refresh()
    await answer(2)
    await vi.waitFor(() => expect(follower.directEndpoint()).toBe(MOVED_LAN))
    expect(dialed).toEqual([...dead, MOVED_LAN])
    follower.stop()
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
