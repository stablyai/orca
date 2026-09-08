import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionQuickCommandOperations } from './host-session-quick-command-operations'

export function defaultHostSessionQuickCommandOperations(
  _client: RpcClient
): HostSessionQuickCommandOperations | null {
  return null
}
