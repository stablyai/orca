import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  SshHostNotServedError,
  SSH_WORKTREE_REMOVAL_NOT_SERVED_MESSAGE
} from '../../../providers/ssh-host-not-served-error'
import { resolveWorktreeRemovalHomeForHost } from '../../../workspaces/removal/worktree-removal-execution-host-route'
import {
  getNestedWorktreeRemovalPlan,
  assertNestedWorktreeRemovalApproval,
  removeNestedWorktreePlanChildren
} from '../../../workspaces/removal/nested-worktree-removal-plan'
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
  if (repo.connectionId) {
    throw new SshHostNotServedError(repo.connectionId, SSH_WORKTREE_REMOVAL_NOT_SERVED_MESSAGE)
  }
  const worktrees = await listWorktreesStrict(
    repo.path,
    getLocalProjectWorktreeGitOptions(context.store, repo)
  )
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
  return removeNestedWorktreePlanChildren(repo.id, plan, (worktreeId, child) =>
    remove({
      ...removalArgs,
      hostId,
      worktreeId,
      approvedNestedWorktrees: undefined,
      expectedCheckout: child
    })
  )
}
