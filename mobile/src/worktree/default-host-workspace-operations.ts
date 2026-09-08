import type { RpcClient } from '../transport/rpc-client'
import type { HostWorkspaceOperations } from './host-workspace-operations'
import { nativeHostWorkspaceOperations } from './native-host-workspace-operations'

export function defaultHostWorkspaceOperations(client: RpcClient): HostWorkspaceOperations {
  return nativeHostWorkspaceOperations(client)
}
