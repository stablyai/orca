import type { HostTaskReadOperations } from './host-task-read-operations'
import { nativeHostTaskReadOperations } from './native-host-task-read-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskReadOperations(client: RpcClient): HostTaskReadOperations {
  return nativeHostTaskReadOperations(client)
}
