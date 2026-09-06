import type { HostTaskProviderWriteOperations } from './host-task-provider-write-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskProviderWriteOperations(
  _client: RpcClient
): HostTaskProviderWriteOperations {
  throw new Error('Hosted Tasks requires explicit provider write operations')
}
