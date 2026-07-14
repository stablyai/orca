import type { TuiAgent } from '../../../src/shared/types'
import type { RpcClient } from '../transport/rpc-client'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'
import type { WorkspaceCreateSetupDecision } from './workspace-create-params'

// The blank/named create path, extracted from NewWorktreeModal so the modal keeps
// only the UI-coupled setup-trust flow. Assembles worktree.create params and
// applies the shared name-collision retry.
export async function createBlankWorkspace(args: {
  client: RpcClient
  repoId: string
  baseName: string
  startupCommand: string | undefined
  createdWithAgentId: TuiAgent | undefined
  comment: string | undefined
  setupDecision: WorkspaceCreateSetupDecision
}): Promise<WorktreeCreateResult> {
  return createWorktreeWithNameRetry({
    client: args.client,
    baseName: args.baseName,
    buildParams: (name) => {
      const params: Record<string, unknown> = {
        repo: `id:${args.repoId}`,
        startupCommand: args.startupCommand,
        setupDecision: args.setupDecision,
        name
      }
      if (args.createdWithAgentId) {
        params.createdWithAgent = args.createdWithAgentId
      }
      if (args.comment) {
        params.comment = args.comment
      }
      return params
    }
  })
}
