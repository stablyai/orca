import type { RpcClient } from '../transport/rpc-client'
import type { HostTaskOperations } from './host-task-operations'
import { nativeHostTaskOperations } from './native-host-task-operations'

export function defaultHostTaskOperations(client: RpcClient): HostTaskOperations {
  return nativeHostTaskOperations(client)
}
