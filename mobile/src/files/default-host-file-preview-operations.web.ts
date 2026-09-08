import type { RpcClient } from '../transport/rpc-client'
import type { HostFilePreviewOperations } from './host-file-preview-operations'

export function defaultHostFilePreviewOperations(
  _client: RpcClient,
  _reconnect: () => Promise<void>
): HostFilePreviewOperations | null {
  return null
}
