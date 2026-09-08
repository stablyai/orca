import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionQuickCommandOperations } from './host-session-quick-command-operations'
import { nativeHostSessionQuickCommandOperations } from './native-host-session-quick-command-operations'

export function defaultHostSessionQuickCommandOperations(
  client: RpcClient
): HostSessionQuickCommandOperations {
  return nativeHostSessionQuickCommandOperations(client)
}
