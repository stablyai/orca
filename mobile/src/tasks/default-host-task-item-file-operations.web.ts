import type { HostTaskItemFileOperations } from './host-task-item-file-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskItemFileOperations(_client: RpcClient): HostTaskItemFileOperations {
  throw new Error('Hosted Tasks requires explicit item file operations')
}
