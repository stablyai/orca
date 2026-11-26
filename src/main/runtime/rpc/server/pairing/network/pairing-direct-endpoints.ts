import { listAutoAdvertisedPairingAddresses } from '../../../../../../shared/remote-runtime/pairing/pairing-address-auto-selection'
import { classifyRemotePairingHostname } from '../../../../../../shared/remote-runtime/pairing/remote-pairing-address'
import { isPairingWildcardHostname } from '../../../../../../shared/network/pairing-url'
import { resolveAdvertisedPairingEndpoint } from './pairing-endpoint'
import {
  getPairingNetworkInterfaces,
  type DefaultRouteInterfaceLookup
} from './pairing-network-interfaces'
import { getWindowsDefaultRouteInterfaceNames } from './windows-default-route-interfaces'

const DIRECT_ENDPOINTS_CACHE_MS = 30_000
const MAX_DIRECT_ENDPOINTS = 64

type CachedRead = { boundEndpoint: string; endpoints: Promise<string[]>; settledAt: number | null }

/**
 * The direct endpoints a fresh QR could advertise for the live listener, best first.
 * Every phone connect asks, and the Windows default-route lookup spawns PowerShell, so one
 * read is shared while in flight and reused briefly.
 */
export function createPairingDirectEndpointsReader(
  readBoundEndpoint: () => string | null,
  lookup: DefaultRouteInterfaceLookup = getWindowsDefaultRouteInterfaceNames,
  now: () => number = Date.now
): () => Promise<string[]> {
  let cached: CachedRead | null = null
  return () => {
    const boundEndpoint = readBoundEndpoint()
    if (!boundEndpoint) {
      return Promise.resolve([])
    }
    if (
      cached?.boundEndpoint === boundEndpoint &&
      (cached.settledAt === null || now() - cached.settledAt < DIRECT_ENDPOINTS_CACHE_MS)
    ) {
      return cached.endpoints
    }
    const entry: CachedRead = {
      boundEndpoint,
      endpoints: listDirectEndpoints(boundEndpoint, lookup).catch(() => []),
      settledAt: null
    }
    void entry.endpoints.then(() => {
      entry.settledAt = now()
    })
    cached = entry
    return entry.endpoints
  }
}

async function listDirectEndpoints(
  boundEndpoint: string,
  lookup: DefaultRouteInterfaceLookup
): Promise<string[]> {
  const boundHost = new URL(boundEndpoint).hostname.replace(/^\[|\]$/g, '')
  if (classifyRemotePairingHostname(boundHost) === 'loopback') {
    return []
  }
  if (!isPairingWildcardHostname(boundHost)) {
    // A pinned interface bind answers only on its own address.
    return [boundEndpoint]
  }
  const addresses = listAutoAdvertisedPairingAddresses(
    await getPairingNetworkInterfaces(boundHost, lookup)
  )
  const endpoints: string[] = []
  for (const address of addresses.slice(0, MAX_DIRECT_ENDPOINTS)) {
    const resolved = resolveAdvertisedPairingEndpoint(boundEndpoint, address)
    if (resolved.ok) {
      endpoints.push(resolved.endpoint)
    }
  }
  return endpoints
}
