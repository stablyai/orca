import type { RpcClient } from '../transport/rpc-client'
import type { HostFileExplorerOperations } from './host-file-explorer-operations'

export function defaultHostFileExplorerOperations(
  _client: RpcClient,
  _reconnect: () => Promise<void>
): HostFileExplorerOperations | null {
  return null
}
