import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import type { HostListSnapshot } from './host-list-load-sharing'
import type { HostCatalogEntry, StoredHostProfile } from './host-profile'

export async function joinHostCatalogCredentials(args: {
  storedHosts: readonly StoredHostProfile[]
  relays: ReadonlyMap<string, MobileRelayEndpoint>
  tokenCache: Map<string, string>
  readToken: (hostId: string) => Promise<string | null>
  getRevision: () => number
}): Promise<HostListSnapshot> {
  const catalog = await Promise.all(
    args.storedHosts.map(async (stored): Promise<HostCatalogEntry> => {
      let token = args.tokenCache.get(stored.id)
      let credentialStatus: HostCatalogEntry['credentialStatus'] = 'ready'
      if (!token) {
        const readRevision = args.getRevision()
        let fetched: string | null
        try {
          fetched = await args.readToken(stored.id)
        } catch {
          credentialStatus = 'temporarily-unavailable'
          fetched = null
        }
        if (!fetched && credentialStatus === 'ready') {
          credentialStatus = 'missing'
        }
        token = fetched ?? undefined
        if (token && readRevision === args.getRevision()) {
          args.tokenCache.set(stored.id, token)
        }
      }
      const relay = args.relays.get(stored.id)
      const base = { ...stored, ...(relay ? { relay } : {}) }
      const profile = token ? { ...base, deviceToken: token } : null
      return { ...base, credentialStatus, profile }
    })
  )
  return { catalog, profiles: catalog.flatMap(({ profile }) => (profile ? [profile] : [])) }
}
