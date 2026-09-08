import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'
import { nativeHostSessionTerminalOperations } from './native-host-session-terminal-operations'

export function defaultHostSessionTerminalOperations(
  client: RpcClient
): HostSessionTerminalOperations {
  return nativeHostSessionTerminalOperations(client)
}
