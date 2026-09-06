import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionTerminalFileOperations } from './host-session-terminal-file-operations'
import { nativeHostSessionTerminalFileOperations } from './native-host-session-terminal-file-operations'

export function defaultHostSessionTerminalFileOperations(
  client: RpcClient
): HostSessionTerminalFileOperations {
  return nativeHostSessionTerminalFileOperations(client)
}
