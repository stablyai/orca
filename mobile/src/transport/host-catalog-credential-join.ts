import type { MobileRelayHostOverlay } from './mobile-relay-host-overlay'
import type { HostListSnapshot } from './host-list-load-sharing'
import type { HostCatalogEntry, StoredHostProfile } from './types'

export async function joinHostCatalogCredentials(args: {
  storedHosts: readonly StoredHostProfile[]
  overlays: ReadonlyMap<string, MobileRelayHostOverlay>
  tokenCache: Map<string, string>
  readToken: (hostId: string) => Promise<string | null>
  getRevision: () => number
}): Promise<HostListSnapshot> {
  const catalog: HostCatalogEntry[] = []
  const profiles: HostListSnapshot['profiles'] = []
  for (const stored of args.storedHosts) {
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
    const overlay = args.overlays.get(stored.id)
    const base = {
      ...stored,
      ...(overlay
        ? {
            endpoints: overlay.endpoints,
            relayHostId: overlay.relayHostId,
            relay: overlay.relay
          }
        : {})
    }
    const profile = token ? { ...base, deviceToken: token } : null
    catalog.push({ ...base, credentialStatus, profile })
    if (profile) {
      profiles.push(profile)
    }
  }
  return { catalog, profiles }
}
