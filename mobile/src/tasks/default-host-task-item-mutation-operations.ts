import type { HostTaskItemMutationOperations } from './host-task-item-mutation-operations'
import { nativeHostTaskItemMutationOperations } from './native-host-task-item-mutation-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskItemMutationOperations(
  client: RpcClient
): HostTaskItemMutationOperations {
  return nativeHostTaskItemMutationOperations(client)
}
