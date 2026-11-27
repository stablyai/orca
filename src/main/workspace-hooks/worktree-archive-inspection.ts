import type { Repo } from '../../shared/repository/repo-types'
import { splitWorktreeId } from '../../shared/worktree/id'
import { isFolderRepo } from '../../shared/repository/repo-kind'
import { listWorktreesStrict } from '../git/worktrees/catalog/worktree-listing'
import { areWorktreePathsEqual } from '../git/worktrees/catalog/worktree-path-comparison'
import type { LocalProjectWorktreeGitOptions } from '../workspaces/execution-host/project-runtime-git-options'
import { findRegisteredDeletableWorktree } from '../workspaces/removal/worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../workspaces/removal/worktree-removal-home-guard'
import { readWorktreeArchiveHooks } from './worktree-archive-source'
import { nativeWindowsMarkerMissing } from '../git/worktrees/removal/windows-worktree-removal'

export async function inspectWorktreeArchiveHooks(
  repo: Repo,
  worktreeId: string,
  gitOptions: LocalProjectWorktreeGitOptions
) {
  const target = splitWorktreeId(worktreeId)
  if (!target || target.repoId !== repo.id || isFolderRepo(repo)) {
    throw new Error('Archive inspection requires a worktree belonging to this project.')
  }
  const worktrees = await listWorktreesStrict(repo.path, gitOptions)
  const registered = findRegisteredDeletableWorktree(
    repo.path,
    target.worktreePath,
    worktrees.filter((item) => areWorktreePathsEqual(item.path, target.worktreePath)),
    CLIENT_REMOVAL_HOME
  )
  // Unregistered cleanup cannot execute a checkout hook.
  const resolved =
    registered && !(await nativeWindowsMarkerMissing(registered.path, gitOptions))
      ? await readWorktreeArchiveHooks(repo, registered.path, gitOptions)
      : undefined
  if (resolved?.checkoutSource) {
    // Checkout approvals are per target; nested checkouts must be reviewed and removed first.
    findRegisteredDeletableWorktree(repo.path, target.worktreePath, worktrees, CLIENT_REMOVAL_HOME)
  }
  return {
    status: 'ok' as const,
    hasHooks: Boolean(resolved?.sharedArchive),
    hooks: resolved?.sharedArchive ? { scripts: { archive: resolved.sharedArchive } } : null,
    mayNeedUpdate: false,
    archiveApprovalHash: resolved?.approvalHash ?? 'unregistered'
  }
}
