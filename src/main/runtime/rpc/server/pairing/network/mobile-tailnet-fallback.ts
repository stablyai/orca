import { WebSocketTransport } from '../../../transports/websocket/ws-transport'
import type { RpcTransport } from '../../../transport'
import { WS_BIND_HOST_ALL_INTERFACES } from '../../runtime-rpc-pairing-types'
import { getPairingNetworkInterfaces } from './pairing-network-interfaces'
import { isTailnetIPv4Address } from '../../../../../../shared/network/tailnet-address'
import { isVirtualBridgeInterface } from '../../../../../../shared/remote-runtime/pairing/pairing-address-auto-selection'
import type { NetworkInterface } from './pairing-network-interfaces'

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
