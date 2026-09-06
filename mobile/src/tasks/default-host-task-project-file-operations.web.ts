import type { HostTaskProjectFileOperations } from './host-task-project-file-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskProjectFileOperations(
  _client: RpcClient
): HostTaskProjectFileOperations {
  throw new Error('Hosted Tasks requires explicit GitHub Project file operations')
}
