import type { HostTaskListOperations } from './host-task-list-operations'
import { nativeHostTaskListOperations } from './native-host-task-list-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskListOperations(client: RpcClient): HostTaskListOperations {
  return nativeHostTaskListOperations(client)
}
