import {
  PairingGetDirectEndpointsResultSchema,
  type PairingDirectEndpoint
} from '../../../src/shared/pairing-direct-endpoints'
import { bindDeferredRpcOperation, defineRpcOperation } from './rpc-operation'
import { rpcResultVariant } from './rpc-operation-result-reader'
import type { RpcClient } from './rpc-client'
import type { HostProfile } from './types'

const directEndpointsRead = bindDeferredRpcOperation(
  defineRpcOperation({
    name: 'pairing.direct-endpoints',
    method: 'pairing.getDirectEndpoints',
    acceptance: 'require-result-or-throw',
    barrier: 'after-caller-barrier',
    read: rpcResultVariant('direct-endpoints', PairingGetDirectEndpointsResultSchema)
  })
)

export class MobileDirectEndpointDiscovery {
  private endpoints: PairingDirectEndpoint[] | undefined

  async getProbeHost(
    client: RpcClient,
    host: HostProfile,
    signal?: AbortSignal
  ): Promise<HostProfile | null> {
    if (signal?.aborted) {
      return null
    }
    if (client.getState() === 'connected') {
      try {
        const response = await directEndpointsRead.request(
          client,
          {},
          {
            // Windows route discovery can take up to three seconds.
            timeoutMs: 5000,
            budgetSpansConnect: true,
            failWhenDisconnected: true
          }
        )
        // Older hosts refuse unknown mobile methods as either forbidden or method_not_found.
        if (response.ok && !signal?.aborted) {
          this.endpoints = directEndpointsRead.interpret(response).endpoints
        }
      } catch {
        // A failed optional discovery must not disturb the authenticated connection.
      }
    }
    if (signal?.aborted) {
      return null
    }
    if (!this.endpoints) {
      return host
    }
    const first = this.endpoints[0]
    if (!first) {
      return null
    }
    // Keep discovery session-local so it cannot overwrite the user's fallback address or credentials.
    return {
      ...host,
      endpoint: first.url,
      endpoints: this.endpoints.map((endpoint, index) => ({
        ...endpoint,
        id: `discovered-${index}`
      }))
    }
  }
}
