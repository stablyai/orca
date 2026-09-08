import type { RpcClient } from '../transport/rpc-client'
import type { HostWorkspaceCreationOperations } from './host-workspace-creation-operations'

export function defaultHostWorkspaceCreationOperations(
  _client: RpcClient
): HostWorkspaceCreationOperations | null {
  return null
}
