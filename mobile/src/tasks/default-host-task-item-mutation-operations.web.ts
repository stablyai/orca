import type { HostTaskItemMutationOperations } from './host-task-item-mutation-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskItemMutationOperations(
  _client: RpcClient
): HostTaskItemMutationOperations {
  throw new Error('Hosted Tasks requires explicit item mutation operations')
}
