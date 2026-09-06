import type { HostTaskListOperations } from './host-task-list-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskListOperations(_client: RpcClient): HostTaskListOperations {
  throw new Error('Hosted Tasks requires explicit task list operations')
}
