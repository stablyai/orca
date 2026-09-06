import type { HostTaskProjectMutationOperations } from './host-task-project-mutation-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskProjectMutationOperations(
  _client: RpcClient
): HostTaskProjectMutationOperations {
  throw new Error('Hosted Tasks requires explicit GitHub Project mutation operations')
}
