import type { HostTaskLinearOperations } from './host-task-linear-operations'
import { nativeHostTaskLinearOperations } from './native-host-task-linear-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskLinearOperations(client: RpcClient): HostTaskLinearOperations {
  return nativeHostTaskLinearOperations(client)
}
