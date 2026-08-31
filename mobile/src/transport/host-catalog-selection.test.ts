import { describe, expect, it } from 'vitest'
import { selectConnectableHostProfiles, sortHostsByLastConnected } from './host-catalog-selection'
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

  it('sorts hosts by recency without copied-array methods or input mutation', () => {
    const hosts = [
      { ...profile, id: 'oldest', lastConnected: 1 },
      { ...profile, id: 'newest', lastConnected: 3 },
      { ...profile, id: 'middle', lastConnected: 2 }
    ]
    const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toSorted')
    Reflect.deleteProperty(Array.prototype, 'toSorted')

    try {
      expect(sortHostsByLastConnected(hosts).map((host) => host.id)).toEqual([
        'newest',
        'middle',
        'oldest'
      ])
      expect(hosts.map((host) => host.id)).toEqual(['oldest', 'newest', 'middle'])
    } finally {
      if (descriptor) {
        Reflect.defineProperty(Array.prototype, 'toSorted', descriptor)
      }
    }
  })
})
