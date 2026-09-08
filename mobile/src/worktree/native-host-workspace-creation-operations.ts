import type { RpcClient } from '../transport/rpc-client'
import { createBlankWorkspace } from '../tasks/blank-workspace-create'
import { createWorkspaceFromComposerSource } from '../tasks/source-workspace-create'
import type { HostWorkspaceCreationOperations } from './host-workspace-creation-operations'
import { rpcWorkspaceCreationOperations } from './rpc-workspace-creation-operations'

export function nativeHostWorkspaceCreationOperations(
  client: RpcClient
): HostWorkspaceCreationOperations {
  return {
    ...rpcWorkspaceCreationOperations(client),
    async createBlankWorkspace(args) {
      return createBlankWorkspace({
        client,
        ...args,
        createdWithAgentId: args.agentChoice === 'blank' ? undefined : args.agentChoice
      })
    },
    async createWorkspaceFromSource(args) {
      return createWorkspaceFromComposerSource({
        client,
        ...args,
        agent: { choice: args.agentChoice }
      })
    }
  }
}
