import type { RpcClient } from '../transport/rpc-client'
import type { MobileWebCapabilityBrokerOptions } from './mobile-web-capability-broker-options'
import { MobileWebBrokerError } from './mobile-web-broker-error'

export function requireMobileWebConnectedClient(
  options: Pick<MobileWebCapabilityBrokerOptions, 'isConnected' | 'getClient'>
): RpcClient {
  if (!options.isConnected()) {
    throw new MobileWebBrokerError('not_connected')
  }
  const client = options.getClient()
  if (!client) {
    throw new MobileWebBrokerError('not_connected')
  }
  return client
}
