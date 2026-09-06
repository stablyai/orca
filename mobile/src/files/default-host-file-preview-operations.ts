import type { RpcClient } from '../transport/rpc-client'
import type { HostFilePreviewOperations } from './host-file-preview-operations'
import { nativeHostFilePreviewOperations } from './native-host-file-preview-operations'

export function defaultHostFilePreviewOperations(
  client: RpcClient,
  reconnect: () => Promise<void>
): HostFilePreviewOperations {
  return nativeHostFilePreviewOperations(client, reconnect)
}
