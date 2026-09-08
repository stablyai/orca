import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionBrowserOperations } from './host-session-browser-operations'

export function defaultHostSessionBrowserOperations(
  _client: RpcClient
): HostSessionBrowserOperations | null {
  return null
}
