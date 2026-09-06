import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionTerminalFileOperations } from './host-session-terminal-file-operations'

export function defaultHostSessionTerminalFileOperations(
  _client: RpcClient
): HostSessionTerminalFileOperations | null {
  return null
}
