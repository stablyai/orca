import type { HostTaskProjectMutationOperations } from './host-task-project-mutation-operations'
import { nativeHostTaskProjectMutationOperations } from './native-host-task-project-mutation-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskProjectMutationOperations(
  client: RpcClient
): HostTaskProjectMutationOperations {
  return nativeHostTaskProjectMutationOperations(client)
}
