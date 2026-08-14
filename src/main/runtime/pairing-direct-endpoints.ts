import {
  isVirtualBridgeInterface,
  selectAutoAdvertisedPairingAddress,
  type PairingNetworkInterface
} from '../../shared/pairing-address-auto-selection'
import { classifyRemotePairingHostname } from '../../shared/remote-pairing-address'
import { isTailnetIPv4Address } from '../../shared/tailnet-address'
import type { PairingGetDirectEndpointsResult } from '../../shared/mobile-relay-credential-contract'
import { resolveAdvertisedPairingEndpoint } from './pairing-endpoint'
import { getPairingNetworkInterfaces } from './pairing-network-interfaces'

// Why: overlay max is 16 including the relay row; keep a short ranked LAN list.
export const MAX_ADVERTISED_DIRECT_ENDPOINTS = 8

const EMPTY_DIRECT_ENDPOINTS: PairingGetDirectEndpointsResult = {
  v: 1,
  selected: null,
  endpoints: []
}

export function isLoopbackWebSocketBind(endpoint: string): boolean {
  try {
    const hostname = new URL(endpoint).hostname.replace(/^\[|\]$/g, '')
    return classifyRemotePairingHostname(hostname) === 'loopback'
  } catch {
    return true
  }
}

export function advertisePairingDirectEndpoints(args: {
  boundEndpoint: string | null
  interfaces: readonly PairingNetworkInterface[]
}): PairingGetDirectEndpointsResult {
  const bound = args.boundEndpoint
  if (!bound || isLoopbackWebSocketBind(bound)) {
    return EMPTY_DIRECT_ENDPOINTS
  }

  const advertisable = args.interfaces.filter(
    (iface) =>
      !isVirtualBridgeInterface(iface.name, iface.hasDefaultRoute) &&
      classifyRemotePairingHostname(iface.address) !== 'loopback' &&
      !/^198\.(?:18|19)\./.test(iface.address)
  )
  const selectedAddress = selectAutoAdvertisedPairingAddress(advertisable)
  const ordered = [
    ...advertisable.filter((iface) => iface.address === selectedAddress),
    ...advertisable.filter((iface) => iface.address !== selectedAddress)
  ]

  const endpoints: PairingGetDirectEndpointsResult['endpoints'] = []
  const seen = new Set<string>()
  for (const iface of ordered) {
    const resolved = resolveAdvertisedPairingEndpoint(bound, iface.address)
    if (!resolved.ok || seen.has(resolved.endpoint)) {
      continue
    }
    let hostname: string
    try {
      hostname = new URL(resolved.endpoint).hostname.replace(/^\[|\]$/g, '')
    } catch {
      continue
    }
    if (classifyRemotePairingHostname(hostname) === 'loopback') {
      continue
    }
    seen.add(resolved.endpoint)
    endpoints.push({
      kind: isTailnetIPv4Address(hostname) ? 'tailscale' : 'lan',
      url: resolved.endpoint
    })
    if (endpoints.length >= MAX_ADVERTISED_DIRECT_ENDPOINTS) {
      break
    }
  }

  return {
    v: 1,
    selected: endpoints[0] ?? null,
    endpoints
  }
}

export async function resolveDesktopDirectEndpoints(args: {
  connectionMode: string | undefined
  boundEndpoint: string | null
}): Promise<PairingGetDirectEndpointsResult> {
  if (args.connectionMode === 'local-only') {
    return { v: 1, selected: null, endpoints: [] }
  }
  return advertisePairingDirectEndpoints({
    boundEndpoint: args.boundEndpoint,
    interfaces: await getPairingNetworkInterfaces()
  })
}
