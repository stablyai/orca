import type { RpcClient } from '../transport/rpc-client'
import type { HostWorkspaceCreationOperations } from './host-workspace-creation-operations'
import { rpcWorkspaceCreationOperations } from './rpc-workspace-creation-operations'

export function nativeHostWorkspaceCreationOperations(
  client: RpcClient
): HostWorkspaceCreationOperations {
  return rpcWorkspaceCreationOperations(client)
}
