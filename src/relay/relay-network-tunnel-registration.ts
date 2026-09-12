import type { RelayDispatcher } from './dispatcher'
import type { RelayNetworkTunnelRegistry } from './relay-network-tunnel-registry'
import {
  RELAY_NETWORK_TUNNEL_CAPABILITY,
  RELAY_NETWORK_TUNNEL_CLOSE_METHOD,
  RELAY_NETWORK_TUNNEL_FRAME_METHOD,
  RELAY_NETWORK_TUNNEL_OPEN_METHOD
} from '../shared/relay-network-tunnel-contract'

export function registerRelayNetworkTunnels(
  dispatcher: Pick<RelayDispatcher, 'onRequest' | 'onNotification'>,
  registry: RelayNetworkTunnelRegistry,
  runtimeIncarnation: string,
  ownsEndpoint: () => boolean
) {
  dispatcher.onRequest(RELAY_NETWORK_TUNNEL_OPEN_METHOD, async (params, context) =>
    registry.open(params, context)
  )
  dispatcher.onNotification(RELAY_NETWORK_TUNNEL_FRAME_METHOD, (params, context) =>
    registry.handleFrame(params, context)
  )
  dispatcher.onRequest(RELAY_NETWORK_TUNNEL_CLOSE_METHOD, async (params, context) => {
    await registry.close(params, context)
    return { closed: true }
  })
  return (): {
    capabilities: string[]
    networkTunnel?: { version: 1; runtimeIncarnation: string }
  } =>
    ownsEndpoint() && registry.admissionOpen
      ? {
          capabilities: [RELAY_NETWORK_TUNNEL_CAPABILITY],
          networkTunnel: { version: 1, runtimeIncarnation }
        }
      : { capabilities: [] }
}
