import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { gitExecFileAsync } from '../../git/command-runner/git-exec-file'
import { gitExecOptions } from '../../git/worktrees/worktree-operation-options'
import { isAlreadyRemovedWorktreePath } from '../../ipc/worktrees/removal/worktree-removal-filesystem'
import type { LocalProjectWorktreeGitOptions } from '../execution-host/project-runtime-git-options'
import type { WorktreeRemovalHomeAuthority } from './worktree-removal-home-guard'
import { findRegisteredDeletableWorktree } from './worktree-removal-safety'

// `git worktree add` holds this lock only while it runs, and creates the checkout right after taking it.
const GIT_WORKTREE_ADD_LOCK_REASON = 'initializing'

/** Like findRegisteredDeletableWorktree, but first runs `git worktree unlock` on a died add whose checkout is gone: Git never marks a locked row prunable (#17654). */
export async function findRegisteredWorktreeReleasingDiedAddLock(
  repoPath: string,
  worktreePath: string,
  worktrees: readonly GitWorktreeInfo[],
  home: WorktreeRemovalHomeAuthority,
  options: LocalProjectWorktreeGitOptions
): Promise<GitWorktreeInfo | null> {
  const worktree = findRegisteredDeletableWorktree(repoPath, worktreePath, worktrees, home)
  if (
    !worktree?.locked ||
    worktree.lockReason !== GIT_WORKTREE_ADD_LOCK_REASON ||
    !(await isAlreadyRemovedWorktreePath(worktree.path, options))
  ) {
    return worktree
  }
  await gitExecFileAsync(
    ['worktree', 'unlock', '--', worktree.path],
    gitExecOptions(repoPath, options)
  )
  const { locked: _locked, lockReason: _lockReason, ...unlocked } = worktree
  return unlocked
}
