import { describe, expect, it } from 'vitest'
import { selectConnectableHostProfiles } from './host-catalog-selection'
import type { HostCatalogEntry, HostProfile } from './types'

const profile: HostProfile = {
  id: 'host-ready',
  name: 'Ready',
  endpoint: 'ws://127.0.0.1:1',
  deviceToken: 'token',
  publicKeyB64: 'key-ready',
  lastConnected: 0
}

function unavailable(
  id: string,
  credentialStatus: 'temporarily-unavailable' | 'missing'
): HostCatalogEntry {
  return {
    id,
    name: id,
    endpoint: `ws://127.0.0.1/${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 0,
    credentialStatus,
    profile: null
  }
}

describe('selectConnectableHostProfiles', () => {
  it('excludes unavailable catalog entries from connection priming', () => {
    expect(
      selectConnectableHostProfiles([
        { ...profile, credentialStatus: 'ready', profile },
        unavailable('host-locked', 'temporarily-unavailable'),
        unavailable('host-missing', 'missing')
      ])
    ).toEqual([profile])
  })
})
