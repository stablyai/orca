import type { HostTaskProjectFileOperations } from './host-task-project-file-operations'
import { nativeHostTaskProjectFileOperations } from './native-host-task-project-file-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskProjectFileOperations(
  client: RpcClient
): HostTaskProjectFileOperations {
  return nativeHostTaskProjectFileOperations(client)
}
