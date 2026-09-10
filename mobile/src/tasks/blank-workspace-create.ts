import type { TuiAgent } from '../../../src/shared/tui-agent'
import type { RpcClient } from '../transport/rpc-client'
import { createWorktreeWithNameRetry, type WorktreeCreateResult } from './worktree-create-retry'
import type { WorktreeCreateAgentLaunch } from './agent-launch-worktree-create'
import type { WorktreeCreateIdempotencyProbe } from './worktree-create-idempotency-policy'
import {
  startupAgentCreateFields,
  type WorkspaceCreateSetupDecision
} from './workspace-create-params'

// The blank/named create path, extracted from NewWorktreeModal so the modal keeps
// only the UI-coupled setup-trust flow. Assembles worktree.create params and
// applies the shared name-collision retry.
export async function createBlankWorkspace(args: {
  client: RpcClient
  repoId: string
  baseName: string
  createdWithAgentId: TuiAgent | undefined
  comment: string | undefined
  setupDecision: WorkspaceCreateSetupDecision
  /** True when `baseName` is a generated creature name rather than one the user typed; only then
   *  may the host retire it. */
  nameWasGenerated: boolean
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  /** Whether the host can settle the surface itself; false keeps the agent-first create. */
  agentLaunchSupported: boolean | Promise<boolean>
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
      const params: Record<string, unknown> = {
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
