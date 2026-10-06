import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { listWorktreesStrict } from '../../../git/worktree'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { requireSshGitProvider } from '../../../providers/ssh-git-dispatch'
import { resolveWorktreeRemovalHomeForHost } from '../../../worktree-removal-execution-host-route'
import {
  getNestedWorktreeRemovalPlan,
  assertNestedWorktreeRemovalApproval
} from '../../../nested-worktree-removal-plan'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { assertRemovalHostMatchesRepoRow } from '../repo-host-ownership'

export async function previewNestedWorktreeRemoval(
  context: WorktreeIpcContext,
  repo: Repo,
  worktreePath: string,
  hostId: ExecutionHostId
): Promise<GitWorktreeInfo[]> {
  if (isFolderRepo(repo)) {
    throw new Error('Nested worktree deletion is only available for Git workspaces.')
  }
  assertRemovalHostMatchesRepoRow(repo, repo.id, hostId)
  const worktrees = repo.connectionId
    ? await requireSshGitProvider(repo.connectionId).listWorktrees(repo.path)
    : await listWorktreesStrict(repo.path, getLocalProjectWorktreeGitOptions(context.store, repo))
  return getNestedWorktreeRemovalPlan({
    repoPath: repo.path,
    worktreePath,
    worktrees,
    home: resolveWorktreeRemovalHomeForHost(hostId)
  })
}

export async function removeApprovedNestedWorktrees(args: {
  context: WorktreeIpcContext
  repo: Repo
  worktreePath: string
  hostId: ExecutionHostId
  removalArgs: RemoveWorktreeArgs
  remove: (args: RemoveWorktreeArgs) => Promise<RemoveWorktreeResult>
}): Promise<NonNullable<RemoveWorktreeResult['nestedPreservedBranches']>> {
  const { context, repo, worktreePath, hostId, removalArgs, remove } = args
  if (!removalArgs.force || !removalArgs.approvedNestedWorktrees) {
    throw new Error('Deleting nested worktrees requires an explicit confirmation.')
  }
  const plan = await previewNestedWorktreeRemoval(context, repo, worktreePath, hostId)
  assertNestedWorktreeRemovalApproval(plan, removalArgs.approvedNestedWorktrees)
  const preserved: NonNullable<RemoveWorktreeResult['nestedPreservedBranches']> = []
  for (const child of plan.slice(0, -1)) {
    try {
      const result = await remove({
        ...removalArgs,
        hostId,
        worktreeId: `${repo.id}::${child.path}`,
        approvedNestedWorktrees: undefined,
        expectedCheckout: child
      })
      if (result.preservedBranch) {
        preserved.push({ worktreeId: `${repo.id}::${child.path}`, ...result.preservedBranch })
      }
    } catch (error) {
      const kept =
        preserved.length > 0
          ? ` Branches kept after earlier deletions: ${preserved.map((item) => item.branchName).join(', ')}.`
          : ''
      throw new Error(
        `Could not delete nested worktree ${child.path}: ${error instanceof Error ? error.message : String(error)}${kept}`,
        { cause: error }
      )
    }
  }
  return preserved
}
