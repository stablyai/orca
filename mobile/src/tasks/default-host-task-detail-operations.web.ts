import type { HostTaskDetailOperations } from './host-task-detail-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskDetailOperations(_client: RpcClient): HostTaskDetailOperations {
  throw new Error('Hosted Tasks requires explicit task detail operations')
}
