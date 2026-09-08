import type { RpcClient } from '../transport/rpc-client'
import type { HostWorkspaceCreationOperations } from './host-workspace-creation-operations'
import { nativeHostWorkspaceCreationOperations } from './native-host-workspace-creation-operations'

export function defaultHostWorkspaceCreationOperations(
  client: RpcClient
): HostWorkspaceCreationOperations {
  return nativeHostWorkspaceCreationOperations(client)
}
