import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'
import type { WorktreeCreateAgentLaunch } from './agent-launch-request'
import type { WorktreeCreateIdempotencyProbe } from './worktree-create-idempotency-policy'
import {
  startupAgentCreateFields,
  type WorkspaceCreateParams,
  type WorkspaceCreateSetupDecision
} from './workspace-create-params'

export async function createBlankWorkspace(args: {
  client: RpcClient
  repoId: string
  baseName: string
  createdWithAgentId: TuiAgent | undefined
  comment: string | undefined
  setupDecision: WorkspaceCreateSetupDecision
  // Only generated creature names may be permanently retired by the host.
  nameWasGenerated: boolean
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
}): Promise<WorktreeCreateResult> {
  const agentLaunch: WorktreeCreateAgentLaunch | undefined = args.createdWithAgentId
    ? { agent: args.createdWithAgentId, supported: args.agentLaunchSupported }
    : undefined
  return createWorktreeWithNameRetry({
    client: args.client,
    baseName: args.baseName,
    nameWasGenerated: args.nameWasGenerated,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    ...(agentLaunch ? { agentLaunch } : {}),
    buildParams: (name) => {
      const params: WorkspaceCreateParams = {
        repo: `id:${args.repoId}`,
        setupDecision: args.setupDecision,
        name,
        ...(args.nameWasGenerated
          ? { displayNameKind: 'generated' as const }
          : { displayName: args.baseName, displayNameKind: 'user' as const }),
        ...(args.nameWasGenerated ? { nameWasGenerated: true } : {}),
        ...startupAgentCreateFields(args.createdWithAgentId)
      }
      if (args.comment) {
        params.comment = args.comment
      }
      return params
    }
  })
}
