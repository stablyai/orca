import { WebSocketTransport } from '../../../transports/websocket/ws-transport'
import type { RpcTransport } from '../../../transport'
import { WS_BIND_HOST_ALL_INTERFACES } from '../../runtime-rpc-pairing-types'
import { getPairingNetworkInterfaces } from './pairing-network-interfaces'
import { isTailnetIPv4Address } from '../../../../../../shared/network/tailnet-address'
import { isVirtualBridgeInterface } from '../../../../../../shared/remote-runtime/pairing/pairing-address-auto-selection'
import type { NetworkInterface } from './pairing-network-interfaces'
import { classifyRemotePairingHostname } from '../../../../../../shared/remote-runtime/pairing/remote-pairing-address'

// Expose only a route the live listener already serves, to phones authenticated to this host.
export function selectAuthenticatedMobileTailnetEndpoint(
  interfaces: readonly NetworkInterface[],
  port: number
): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined
  }
  const addresses = new Set(
    interfaces
      .filter(
        (iface) =>
          isTailnetIPv4Address(iface.address) &&
          !isVirtualBridgeInterface(iface.name, iface.hasDefaultRoute)
      )
      .map((iface) => iface.address)
  )
  // Several 100.64/10 addresses (e.g. a corporate VPN beside Tailscale) cannot be told apart; advertise none.
  return addresses.size === 1 ? `ws://${[...addresses][0]}:${port}/` : undefined
}

export async function discoverAuthenticatedMobileTailnetEndpoint(
  boundHost: string | null,
  transports: readonly RpcTransport[]
): Promise<string | undefined> {
  if (boundHost !== WS_BIND_HOST_ALL_INTERFACES) {
    return undefined
  }
  const transport = transports.find(
    (entry): entry is WebSocketTransport => entry instanceof WebSocketTransport
  )
  if (!transport) {
    return undefined
  }
  try {
    return selectAuthenticatedMobileTailnetEndpoint(
      // Why: only non-bridge tailnet addresses qualify, so skip the Windows PowerShell default-route probe.
      await getPairingNetworkInterfaces(boundHost, async () => null),
      transport.resolvedPort
    )
  } catch {
    return undefined
  }
}

// A private address is a useful LAN candidate only when it is unambiguous. Bridge and VPN
// routes can otherwise select an address the phone will never reach.
export function selectAuthenticatedMobileLanEndpoint(
  interfaces: readonly NetworkInterface[],
  port: number
): string | undefined {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined
  }
  const addresses = new Set(
    interfaces
      .filter(
        (iface) =>
          classifyRemotePairingHostname(iface.address) === 'lan' &&
          !isVirtualBridgeInterface(iface.name, iface.hasDefaultRoute)
      )
      .map((iface) => iface.address)
  )
  return addresses.size === 1 ? `ws://${[...addresses][0]}:${port}/` : undefined
}

export type AuthenticatedMobileDirectEndpoints = {
  lanEndpoint?: string
  tailnetEndpoint?: string
}

const DISCOVERY_CACHE_MS = 30_000
let cached: { key: string; until: number; routes: AuthenticatedMobileDirectEndpoints } | null = null
let pending: { key: string; promise: Promise<AuthenticatedMobileDirectEndpoints> } | null = null

async function inspectMobileDirectEndpoints(
  boundHost: string,
  port: number
): Promise<AuthenticatedMobileDirectEndpoints> {
  try {
    // Default-route evidence may invoke Windows PowerShell; the caller caches this lookup.
    const interfaces = await getPairingNetworkInterfaces(boundHost)
    return {
      lanEndpoint: selectAuthenticatedMobileLanEndpoint(interfaces, port),
      tailnetEndpoint: selectAuthenticatedMobileTailnetEndpoint(interfaces, port)
    }
  } catch {
    return {}
  }
}

export async function discoverAuthenticatedMobileDirectEndpoints(
  boundHost: string | null,
  transports: readonly RpcTransport[]
): Promise<AuthenticatedMobileDirectEndpoints> {
  if (boundHost !== WS_BIND_HOST_ALL_INTERFACES) {
    return {}
  }
  const transport = transports.find(
    (entry): entry is WebSocketTransport => entry instanceof WebSocketTransport
  )
  if (!transport) {
    return {}
  }
  const key = `${boundHost}:${transport.resolvedPort}`
  const now = Date.now()
  if (cached?.key === key && now < cached.until) {
    return cached.routes
  }
  if (pending?.key === key) {
    return pending.promise
  }
  const promise = inspectMobileDirectEndpoints(boundHost, transport.resolvedPort)
  pending = { key, promise }
  const routes = await promise
  if (pending?.promise === promise) {
    pending = null
    cached = { key, until: Date.now() + DISCOVERY_CACHE_MS, routes }
  }
  return routes
}
