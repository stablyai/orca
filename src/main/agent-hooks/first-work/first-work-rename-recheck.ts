import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getRepoExecutionHostId } from '../../../shared/execution-host/execution-host'
import { resolveGitRouteForHost } from '../../providers/execution-host-provider-dispatch'
import { probeBranchUpstream, type GitExec } from '../../git/worktrees/checkout/branch-rename'
import { isWslMoveRepoBlocked } from '../../persistence/moving-wsl-projects/orchestration/wsl-move-background-backoff'
import type { FirstWorkBranchRenameDeps } from './first-work-branch-rename'
import type { FirstWorkAttempt, FirstWorkRenameVerdict } from './first-work-rename-attempts'
import { verdictBuilders } from './first-work-rename-verdicts'

/** The mutable guards with no awaits, so a caller can run them in the same turn as the mutation. */
export function syncRenameGuards(
  worktreeId: string,
  deps: FirstWorkBranchRenameDeps,
  attempt: FirstWorkAttempt
): FirstWorkRenameVerdict | null {
  const { stop, defer } = verdictBuilders(worktreeId, deps)
  attempt.assertIncarnation()
  if (!deps.getSettings().autoRenameBranchFromWork) {
    return {
      ...stop('setting-off', 'auto-rename was turned off during generation'),
      settles: false
    }
  }
  const repo = deps.getRepo(getRepoIdFromWorktreeId(worktreeId))
  if (!repo || resolveGitRouteForHost(getRepoExecutionHostId(repo)).kind !== 'local') {
    return { ...stop('unavailable', 'project route changed during generation'), settles: false }
  }
  if (isWslMoveRepoBlocked(repo)) {
    return defer('project-moving', 'a WSL move started before the branch rename')
  }
  if (!deps.canRenameOrcaCreatedBranch(worktreeId)) {
    return stop('name-chosen', 'worktree is not eligible for auto-rename', true)
  }
  return null
}

/** Side-effect-free form of {@link syncRenameGuards} for the runner's admission-time `canStart`. */
export function renameGuardsPass(
  worktreeId: string,
  deps: FirstWorkBranchRenameDeps,
  attempt: FirstWorkAttempt
): boolean {
  const repo = deps.getRepo(getRepoIdFromWorktreeId(worktreeId))
  return (
    attempt.isIncarnationCurrent() &&
    deps.getSettings().autoRenameBranchFromWork === true &&
    !!repo &&
    resolveGitRouteForHost(getRepoExecutionHostId(repo)).kind === 'local' &&
    !isWslMoveRepoBlocked(repo) &&
    deps.canRenameOrcaCreatedBranch(worktreeId)
  )
}

/** The Git-backed rechecks before the rename; the synchronous guards run again at child admission. */
export async function recheckBeforeRename(
  worktreeId: string,
  currentBranch: string,
  exec: GitExec,
  deps: FirstWorkBranchRenameDeps,
  attempt: FirstWorkAttempt
): Promise<FirstWorkRenameVerdict | null> {
  const { stop, defer } = verdictBuilders(worktreeId, deps)
  attempt.assertIncarnation()
  const probe = await probeBranchUpstream(exec)
  // Read HEAD after the probe so the probe provably described `currentBranch`.
  const branchNow = (await exec(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (branchNow !== currentBranch) {
    return defer(
      'branch-changed',
      `branch changed during generation (${currentBranch} -> ${branchNow})`
    )
  }
  if (probe.outcome === 'has-upstream') {
    return {
      ...stop('branch-pushed', `branch "${currentBranch}" was pushed during generation`),
      settles: false
    }
  }
  if (probe.outcome === 'probe-failed') {
    return defer('interrupted', `upstream probe failed after generation: ${probe.message}`)
  }
  return syncRenameGuards(worktreeId, deps, attempt)
}
