import { resolveAdvertisedPairingEndpoint } from './pairing-endpoint'
import {
  getPairingNetworkInterfaces,
  pinnedListenerAddress,
  type DefaultRouteInterfaceLookup
} from './pairing-network-interfaces'
import { getWindowsDefaultRouteInterfaceNames } from './windows-default-route-interfaces'

// The route lookup only ranks adapters; addresses are read fresh so a moved one shows at once.
const DEFAULT_ROUTE_CACHE_MS = 30_000
const MAX_DIRECT_ENDPOINTS = 64

/**
 * Every direct endpoint the live listener answers on, in the QR's preference order. Phones ask on
 * each connect, and on Windows with Hyper-V the default-route lookup spawns PowerShell, so that
 * lookup is shared while in flight and reused briefly.
 */
export function createPairingDirectEndpointsReader(
  readBoundEndpoint: () => string | null,
  lookup: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames,
  now: () => number = Date.now
): () => Promise<string[]> {
  const sharedLookup = shareDefaultRouteLookup(lookup, now)
  return async () => {
    const boundEndpoint = readBoundEndpoint()
    return boundEndpoint ? listDirectEndpoints(boundEndpoint, sharedLookup).catch(() => []) : []
  }
}

function shareDefaultRouteLookup(
  lookup: DefaultRouteInterfaceLookup,
  now: () => number
): DefaultRouteInterfaceLookup {
  type CachedLookup = { names: Promise<ReadonlySet<string> | null>; settledAt: number | null }
  let cached: CachedLookup | null = null
  return () => {
    if (
      cached &&
      (cached.settledAt === null || now() - cached.settledAt < DEFAULT_ROUTE_CACHE_MS)
    ) {
      return cached.names
    }
    const entry: CachedLookup = { names: lookup().catch(() => null), settledAt: null }
    void entry.names.then(() => {
      entry.settledAt = now()
    })
    cached = entry
    return entry.names
  }
}

async function listDirectEndpoints(
  boundEndpoint: string,
  lookup: DefaultRouteInterfaceLookup
): Promise<string[]> {
  const boundHost = new URL(boundEndpoint).hostname.replace(/^\[|\]$/g, '')
  const pinned = pinnedListenerAddress(boundHost)
  if (pinned !== undefined) {
    return pinned ? [boundEndpoint] : []
  }
  // Bridges stay listed (ranked last): the list says which addresses are still this host's, not which to pair.
  const interfaces = await getPairingNetworkInterfaces(boundHost, lookup)
  const endpoints: string[] = []
  for (const { address } of interfaces.slice(0, MAX_DIRECT_ENDPOINTS)) {
    const resolved = resolveAdvertisedPairingEndpoint(boundEndpoint, address)
    if (resolved.ok) {
      endpoints.push(resolved.endpoint)
    }
  }
  return endpoints
}
