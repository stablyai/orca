import { describe, expect, it } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { HostCatalogEntry } from '../transport/types'
import {
  reconcileMobileHomeHostStates,
  type MobileHomeClientEntry
} from './mobile-home-connection-state'

function catalogHost(
  id: string,
  credentialStatus: HostCatalogEntry['credentialStatus']
): HostCatalogEntry {
  return {
    id,
    name: id,
    endpoint: `ws://${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 0,
    credentialStatus,
    profile: null
  }
}

function liveClient(hostId: string, state: MobileHomeClientEntry['state']): MobileHomeClientEntry {
  return { hostId, state, client: {} as RpcClient }
}

describe('mobile home connection state', () => {
  it('keeps an unacquired ready host absent on the initial frame', () => {
    const previous = {}
    const next = reconcileMobileHomeHostStates(previous, [], [catalogHost('host-1', 'ready')])

    expect(next).toBe(previous)
  })

  it('uses credential status when a host has no live client', () => {
    const next = reconcileMobileHomeHostStates(
      { ready: 'connected' },
      [],
      [
        catalogHost('missing', 'missing'),
        catalogHost('locked', 'temporarily-unavailable'),
        catalogHost('ready', 'ready')
      ]
    )

    expect(next).toEqual({ missing: 'auth-failed', locked: 'disconnected', ready: 'disconnected' })
  })

  it('prefers the live client and drops hosts removed from the catalog', () => {
    const next = reconcileMobileHomeHostStates(
      { removed: 'connected', current: 'reconnecting' },
      [liveClient('current', 'connected')],
      [catalogHost('current', 'missing')]
    )

    expect(next).toEqual({ current: 'connected' })
  })
})
