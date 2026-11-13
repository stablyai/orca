import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { getClientWorktreeCreateCandidate } from '../../../../src/shared/new-workspace/worktree-create-retry-policy'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  createWorktreeWithNameRetry,
  type WorktreeCreateParent,
  type WorktreeCreateResult
} from './worktree-create-retry'
import type { WorktreeCreateAgentLaunch } from '../../session/agent-launch/agent-launch-request'
import type { WorktreeCreateIdempotencyProbe } from './worktree-create-idempotency-policy'
import { startupAgentCreateFields, type WorkspaceCreateParams } from './workspace-create-params'
import type { SetupDecision as WorkspaceCreateSetupDecision } from '../../../../src/shared/worktree/create-types'

export async function createBlankWorkspace(args: {
  client: RpcClient
  repoId: string
  baseName: string
  branchNameOverride?: string
  createdWithAgentId: TuiAgent | undefined
  comment: string | undefined
  setupDecision: WorkspaceCreateSetupDecision
  // Only generated creature names may be permanently retired by the host.
  nameWasGenerated: boolean
  worktreeCreateIdempotency: WorktreeCreateIdempotencyProbe
  agentLaunchSupported: WorktreeCreateAgentLaunch['supported']
  parent?: WorktreeCreateParent
}): Promise<WorktreeCreateResult> {
  const agentLaunch: WorktreeCreateAgentLaunch | undefined = args.createdWithAgentId
    ? { agent: args.createdWithAgentId, supported: args.agentLaunchSupported }
    : undefined
  const branchNameOverride = args.branchNameOverride
  return createWorktreeWithNameRetry({
    client: args.client,
    baseName: args.baseName,
    nameWasGenerated: args.nameWasGenerated,
    parent: args.parent,
    worktreeCreateIdempotency: args.worktreeCreateIdempotency,
    ...(agentLaunch ? { agentLaunch } : {}),
    buildParams: (name, attempt) => {
      const params: WorkspaceCreateParams = {
        repo: `id:${args.repoId}`,
        setupDecision: args.setupDecision,
        name,
        ...(branchNameOverride
          ? { branchNameOverride: getClientWorktreeCreateCandidate(branchNameOverride, attempt) }
          : {}),
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
