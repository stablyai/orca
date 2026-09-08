import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionTerminalOperations } from './host-session-terminal-operations'

export function defaultHostSessionTerminalOperations(
  _client: RpcClient
): HostSessionTerminalOperations | null {
  return null
}
