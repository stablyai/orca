import type { HostTaskPreferenceOperations } from './host-task-preference-operations'
import { nativeHostTaskPreferenceOperations } from './native-host-task-preference-operations'
import type { RpcClient } from '../transport/rpc-client'

export function defaultHostTaskPreferenceOperations(
  client: RpcClient
): HostTaskPreferenceOperations {
  return nativeHostTaskPreferenceOperations(client)
}
