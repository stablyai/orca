import type { RpcClient } from '../transport/rpc-client'
import type { HostSessionFileOperations } from './host-session-file-operations'

export function defaultHostSessionFileOperations(
  _client: RpcClient
): HostSessionFileOperations | null {
  return null
}
