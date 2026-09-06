import type { HostTaskProviderWriteOperations } from './host-task-provider-write-operations'
import { nativeHostTaskProviderWriteOperations } from './native-host-task-provider-write-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskProviderWriteOperations(
  client: RpcClient
): HostTaskProviderWriteOperations {
  return nativeHostTaskProviderWriteOperations(client)
}
