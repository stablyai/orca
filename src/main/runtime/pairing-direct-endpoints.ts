import { networkInterfaces } from 'node:os'
import {
  isPairingDirectEndpoint,
  MAX_PAIRING_DIRECT_ENDPOINTS,
  type PairingGetDirectEndpointsResult
} from '../../shared/pairing-direct-endpoints'
import { isPairingWildcardHostname } from '../../shared/network/pairing-url'
import { isVirtualBridgeInterface } from '../../shared/pairing-address-auto-selection'
import { isTailnetIPv4Address } from '../../shared/tailnet-address'
import { getPairingNetworkInterfaces, type NetworkInterface } from './pairing-network-interfaces'
import { resolveAdvertisedPairingEndpoint } from './pairing-endpoint'

const INTERFACE_CACHE_TTL_MS = 60_000
let interfaceCache: {
  snapshot: string
  expiresAt: number
  request: Promise<NetworkInterface[]>
} | null = null

function readDiscoveryInterfaces(): Promise<NetworkInterface[]> {
  const currentInterfaces = networkInterfaces()
  const snapshot = JSON.stringify(currentInterfaces)
  const cacheable = Object.keys(currentInterfaces).some((name) => /^vEthernet /i.test(name))
  if (!cacheable) {
    return getPairingNetworkInterfaces()
  }
  if (interfaceCache?.snapshot === snapshot && Date.now() < interfaceCache.expiresAt) {
    return interfaceCache.request
  }
  // Share Windows route inspection across phones; a changed adapter/address bypasses the TTL.
  const entry = {
    snapshot,
    expiresAt: Number.POSITIVE_INFINITY,
    request: getPairingNetworkInterfaces()
  }
  interfaceCache = entry
  void entry.request.then(
    () => {
      entry.expiresAt = Date.now() + INTERFACE_CACHE_TTL_MS
    },
    () => {
      if (interfaceCache === entry) {
        interfaceCache = null
      }
    }
  )
  return entry.request
}

export async function resolvePairingDirectEndpoints(
  boundEndpoint: string | null
): Promise<PairingGetDirectEndpointsResult> {
  const result: PairingGetDirectEndpointsResult = { v: 1, endpoints: [] }
  if (!boundEndpoint) {
    return result
  }
  const bound = new URL(boundEndpoint)
  const wildcard = isPairingWildcardHostname(bound.hostname)
  // Discovery must never widen a loopback listener or invent another listening port.
  if (!wildcard && !isPairingDirectEndpoint(boundEndpoint)) {
    return result
  }
  const seen = new Set<string>()
  for (const iface of await readDiscoveryInterfaces()) {
    if (isVirtualBridgeInterface(iface.name, iface.hasDefaultRoute)) {
      continue
    }
    const resolved = resolveAdvertisedPairingEndpoint(boundEndpoint, iface.address)
    if (
      !resolved.ok ||
      !isPairingDirectEndpoint(resolved.endpoint) ||
      seen.has(resolved.endpoint)
    ) {
      continue
    }
    const hostname = new URL(resolved.endpoint).hostname
    if (
      (!wildcard && hostname !== bound.hostname) ||
      (bound.hostname === '0.0.0.0' && hostname.includes(':'))
    ) {
      continue
    }
    seen.add(resolved.endpoint)
    result.endpoints.push({
      kind: isTailnetIPv4Address(iface.address) ? 'tailscale' : 'lan',
      url: resolved.endpoint
    })
    if (result.endpoints.length === MAX_PAIRING_DIRECT_ENDPOINTS) {
      break
    }
  }
  return result
}
