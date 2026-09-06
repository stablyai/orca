import type { HostTaskProjectReadOperations } from './host-task-project-read-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskProjectReadOperations(
  _client: RpcClient
): HostTaskProjectReadOperations {
  throw new Error('Hosted Tasks requires explicit GitHub Project read operations')
}
