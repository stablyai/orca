import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionTabOperations } from './host-session-tab-operations'

export function defaultHostSessionTabOperations(
  _client: RpcClient
): HostSessionTabOperations | null {
  return null
}
