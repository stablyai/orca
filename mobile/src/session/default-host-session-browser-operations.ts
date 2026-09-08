import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionBrowserOperations } from './host-session-browser-operations'
import { nativeHostSessionBrowserOperations } from './native-host-session-browser-operations'

export function defaultHostSessionBrowserOperations(
  client: RpcClient
): HostSessionBrowserOperations {
  return nativeHostSessionBrowserOperations(client)
}
