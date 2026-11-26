import {
  PAIRING_GET_DIRECT_ENDPOINTS_METHOD,
  PairingGetDirectEndpointsResultSchema
} from '../../../../src/shared/remote-runtime/pairing/pairing-direct-endpoints-contract'
import { recordHostDirectEndpoints } from '../../host-catalog/host-direct-endpoint-persistence'
import { isPairingRelayRpcUnavailable } from '../../pairing/pairing-relay-rpc-unavailable'
import { bindDeferredRpcOperation, defineRpcOperation } from '../rpc/rpc-operation'
import { rpcResultVariant } from '../rpc/rpc-operation-result-reader'
import type { RpcClient } from '../rpc/rpc-client-contract'

const pairingDirectEndpointsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'pairing.direct-endpoints',
    method: PAIRING_GET_DIRECT_ENDPOINTS_METHOD,
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('direct-endpoints', PairingGetDirectEndpointsResultSchema)
  })
)

export type HostDirectEndpointFollower = { refresh(): void }

/** Asks the connected desktop where it listens now, so a saved direct endpoint can follow a moved address. */
export function createHostDirectEndpointFollower(args: {
  client: RpcClient
  hostId: string
  /** The saved row's direct endpoint after applying the desktop's list; it may differ from a primed copy. */
  onEndpoint: (endpoint: string) => void
}): HostDirectEndpointFollower {
  let unsupported = false
  let inFlight = false
  const read = async (): Promise<void> => {
    const reply = await pairingDirectEndpointsRead.request(args.client, {})
    if (isPairingRelayRpcUnavailable(reply)) {
      // Older desktops never learn this method; asking again on every connect only adds refusals.
      unsupported = true
      return
    }
    const { endpoints } = pairingDirectEndpointsRead.interpret(reply)
    const endpoint = await recordHostDirectEndpoints(args.hostId, endpoints)
    if (endpoint) {
      args.onEndpoint(endpoint)
    }
  }
  return {
    refresh() {
      if (unsupported || inFlight || args.client.getState() !== 'connected') {
        return
      }
      inFlight = true
      void read()
        .catch(() => {
          // Best effort: the next connect or foreground asks again.
        })
        .finally(() => {
          inFlight = false
        })
    }
  }
}
