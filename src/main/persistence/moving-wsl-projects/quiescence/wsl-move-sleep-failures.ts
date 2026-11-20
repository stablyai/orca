/**
 * The workspaces a move's Sleep left awake. Saved rows can outlive their worktree (a checkout
 * deleted outside Orca), and Sleep cannot find one; it is skipped only when nothing of it is left to
 * pause: Git does not list it, its folder is gone and no terminal of it still runs.
 */
import { isAbsolute } from 'node:path'
import type { Repo } from '../../../../shared/repository/repo-types'
import { isFolderRepo } from '../../../../shared/repository/repo-kind'
import { mapWithConcurrency } from '../../../../shared/concurrency/map-with-concurrency'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../../shared/execution-host/execution-host'
import type { WorkspaceSleepOutcome } from '../../../../shared/workspace/lifecycle/workspace-sleep'
import { splitWorktreeId } from '../../../../shared/worktree/id'
import { isLocalRuntimeWorktreePathMissing } from '../../../runtime/workspaces/catalog/runtime-worktree-filesystem'
import { WORKSPACE_SELECTOR_NOT_FOUND } from '../../../runtime/workspaces/catalog/workspace-selector-candidates'
import type { ProjectRuntimeResolutionStore } from '../../../workspaces/execution-host/local-project-runtime-resolution'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'

const REMOVED_WORKTREE_CHECK_CONCURRENCY = 4

export type WslMoveRemovedWorktreeFacts = {
  store: ProjectRuntimeResolutionStore & { getRepos: () => Repo[] }
  hasLiveTerminal: (worktreeId: string) => boolean
}

export async function wslMoveSleepFailures(
  outcomes: readonly WorkspaceSleepOutcome[],
  facts: WslMoveRemovedWorktreeFacts
): Promise<string[]> {
  const notFoundIds = outcomes
    .filter((outcome) => outcome.failure === WORKSPACE_SELECTOR_NOT_FOUND)
    .map((outcome) => outcome.worktreeId)
  // Why: each check can spawn wsl.exe, and stale rows pile up over time.
  const isRemoved = await mapWithConcurrency(
    notFoundIds,
    REMOVED_WORKTREE_CHECK_CONCURRENCY,
    (worktreeId) => isRemovedWorktree(facts, worktreeId)
  )
  const removed = new Set(notFoundIds.filter((_, index) => isRemoved[index]))
  return outcomes
    .filter(
      (outcome) =>
        outcome.chatFailed ||
        Boolean(outcome.vmSuspendFailure) ||
        (Boolean(outcome.failure) && !removed.has(outcome.worktreeId))
    )
    .map((outcome) => outcome.worktreeId)
}

/** A listing gap (a failed scan, a create in flight) keeps its folder; an unreadable one counts as there. */
async function isRemovedWorktree(
  facts: WslMoveRemovedWorktreeFacts,
  worktreeId: string
): Promise<boolean> {
  const parsed = splitWorktreeId(worktreeId)
  const repo =
    parsed &&
    facts.store
      .getRepos()
      .find(
        (candidate) =>
          candidate.id === parsed.repoId &&
          getRepoExecutionHostId(candidate) === LOCAL_EXECUTION_HOST_ID
      )
  if (
    !parsed ||
    !repo ||
    isFolderRepo(repo) ||
    !isAbsolute(parsed.worktreePath) ||
    facts.hasLiveTerminal(worktreeId)
  ) {
    return false
  }
  try {
    return await isLocalRuntimeWorktreePathMissing(
      parsed.worktreePath,
      getLocalProjectWorktreeGitOptions(facts.store, repo)
    )
  } catch {
    return false
  }
}
