import type { RpcClient } from '../transport/rpc-client'
import type { HostFileExplorerOperations } from './host-file-explorer-operations'
import { nativeHostFileExplorerOperations } from './native-host-file-explorer-operations'

export function defaultHostFileExplorerOperations(
  client: RpcClient,
  reconnect: () => Promise<void>
): HostFileExplorerOperations {
  return nativeHostFileExplorerOperations(client, reconnect)
}
