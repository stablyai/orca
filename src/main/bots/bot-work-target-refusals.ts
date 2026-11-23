import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host/execution-host'
import {
  refuse,
  type AgentSessionWireRefusal
} from '../../shared/agent-session/failures/agent-session-wire-refusals'
import type {
  AgentJournalWorkTarget,
  ResolvedBotWorkTargetPlacement
} from '../../shared/agent-session/work-target/agent-session-work-target'
import type { ProjectHostSetup } from '../../shared/project/project-types'
import type { Repo } from '../../shared/repository/repo-types'
import { canonicalWorktreeIdentity } from '../../shared/worktree/identity'
import type { Worktree } from '../../shared/worktree/types'
import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

export type BotWorkTargetValidationResult =
  | { ok: true; placement: ResolvedBotWorkTargetPlacement }
  | { ok: false; refusal: AgentSessionWireRefusal }

export type BotWorkTargetWorkspaceSummary = Pick<
  Worktree,
  'id' | 'repoId' | 'displayName' | 'branch' | 'path' | 'isArchived'
> &
  Partial<Pick<Worktree, 'instanceId' | 'identity' | 'hostId'>>

function refuseTarget(
  reason: 'workTargetUnavailable' | 'workTargetHostUnavailable' | 'workTargetUnsupportedChat',
  message: string
): BotWorkTargetValidationResult {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', { reason }, message) }
}

export const refuseWorkTargetUnavailable = (message: string): BotWorkTargetValidationResult =>
  refuseTarget('workTargetUnavailable', message)

export const refuseWorkTargetHostUnavailable = (message: string): BotWorkTargetValidationResult =>
  refuseTarget('workTargetHostUnavailable', message)

export const refuseWorkTargetUnsupportedChat = (): BotWorkTargetValidationResult =>
  refuseTarget(
    'workTargetUnsupportedChat',
    'Project and workspace targeting is only available in bot chats.'
  )

/** Build an occupant-exact `identity:` selector when instance metadata is present, else `id:`. */
export function resolveWorktreeIdentitySelector(
  managed: Pick<Worktree, 'id'> & Partial<Pick<Worktree, 'identity' | 'instanceId' | 'hostId'>>,
  fallbackHostId: ExecutionHostId
): string {
  const identityKey =
    managed.identity?.key ??
    (managed.instanceId
      ? canonicalWorktreeIdentity({
          worktreeId: managed.id,
          executionHostId: managed.hostId ?? fallbackHostId,
          instanceId: managed.instanceId
        })
      : undefined)
  return identityKey ? `identity:${identityKey}` : `id:${managed.id}`
}

/** Verify a resolved existing workspace still matches the validated host, occupant instance, and repo. */
export function assertManagedWorktreeMatchesTarget(
  managed: { hostId?: ExecutionHostId; instanceId?: string; repoId?: string },
  workTarget: ResolvedBotWorkTargetPlacement
): void {
  if (workTarget.targetHostId && managed.hostId && managed.hostId !== workTarget.targetHostId) {
    throw new OrchestrationError(
      'invalid_argument',
      'The selected target workspace is no longer on its validated host. No effects were applied.',
      { effectsApplied: false }
    )
  }
  if (
    workTarget.expectedWorkspaceInstanceId &&
    managed.instanceId !== workTarget.expectedWorkspaceInstanceId
  ) {
    throw new OrchestrationError(
      'invalid_argument',
      'The selected target workspace changed after validation and was not launched. No effects were applied.',
      { effectsApplied: false }
    )
  }
  if (workTarget.canonicalTarget.repoId && managed.repoId !== workTarget.canonicalTarget.repoId) {
    throw new OrchestrationError(
      'invalid_argument',
      'The selected target workspace no longer matches its validated project. No effects were applied.',
      { effectsApplied: false }
    )
  }
}

/** Find a project's repo on `storeHostId` without ever falling back from a stale explicit `repoId`. */
export function findBotWorkTargetProjectRepo(
  repos: readonly Repo[],
  setups: readonly ProjectHostSetup[],
  storeHostId: ExecutionHostId,
  target: AgentJournalWorkTarget
): Repo | undefined {
  if (target.repoId) {
    return repos.find(
      (repo) => repo.id === target.repoId && getRepoExecutionHostId(repo) === storeHostId
    )
  }
  if (target.projectId) {
    const setupRepoIds = new Set(
      setups
        .filter((setup) => setup.projectId === target.projectId && setup.hostId === storeHostId)
        .map((setup) => setup.repoId)
    )
    return repos.find(
      (repo) => setupRepoIds.has(repo.id) && getRepoExecutionHostId(repo) === storeHostId
    )
  }
  return undefined
}
