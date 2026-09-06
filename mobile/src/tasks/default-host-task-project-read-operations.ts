import type { HostTaskProjectReadOperations } from './host-task-project-read-operations'
import { nativeHostTaskProjectReadOperations } from './native-host-task-project-read-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskProjectReadOperations(
  client: RpcClient
): HostTaskProjectReadOperations {
  return nativeHostTaskProjectReadOperations(client)
}
