import type { RpcClient } from '../transport/rpc-client'
import type { HostWorkspaceOperations } from './host-workspace-operations'

export function defaultHostWorkspaceOperations(_client: RpcClient): HostWorkspaceOperations | null {
  return null
}
