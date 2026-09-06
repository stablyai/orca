import type { HostTaskDetailOperations } from './host-task-detail-operations'
import { nativeHostTaskDetailOperations } from './native-host-task-detail-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskDetailOperations(client: RpcClient): HostTaskDetailOperations {
  return nativeHostTaskDetailOperations(client)
}
