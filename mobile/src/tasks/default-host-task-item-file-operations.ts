import type { HostTaskItemFileOperations } from './host-task-item-file-operations'
import { nativeHostTaskItemFileOperations } from './native-host-task-item-file-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskItemFileOperations(client: RpcClient): HostTaskItemFileOperations {
  return nativeHostTaskItemFileOperations(client)
}
