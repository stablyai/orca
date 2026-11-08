import { describe, expect, it } from 'vitest'
import { joinHostCatalogCredentials } from './host-catalog-credential-join'
import type { StoredHostProfile } from './types'

function storedHost(id: string): StoredHostProfile {
  return {
    id,
    name: id,
    endpoint: `ws://127.0.0.1/${id}`,
    publicKeyB64: `key-${id}`,
    lastConnected: 0
  }
}

describe('joinHostCatalogCredentials', () => {
  it('starts every keychain read at once and keeps the stored order', async () => {
    const started: string[] = []
    const release = new Map<string, (token: string) => void>()
    const join = joinHostCatalogCredentials({
      storedHosts: ['host-a', 'host-b', 'host-c'].map(storedHost),
      relays: new Map(),
      tokenCache: new Map(),
      readToken: (hostId) => {
        started.push(hostId)
        return new Promise((resolve) => release.set(hostId, resolve))
      },
      getRevision: () => 0
    })
    await Promise.resolve()

    expect(started).toEqual(['host-a', 'host-b', 'host-c'])
    release.get('host-c')?.('token-c')
    release.get('host-b')?.('token-b')
    release.get('host-a')?.('token-a')
    const snapshot = await join
    expect(snapshot.catalog.map(({ id }) => id)).toEqual(['host-a', 'host-b', 'host-c'])
    expect(snapshot.profiles.map(({ deviceToken }) => deviceToken)).toEqual([
      'token-a',
      'token-b',
      'token-c'
    ])
  })
})
