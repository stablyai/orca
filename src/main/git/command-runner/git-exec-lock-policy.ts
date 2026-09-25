import {
  resolveGitFetchHeadCommand,
  runWithGitFetchHeadLock
} from '../../../shared/git-fetch-head-lock'
import {
  resolveGitWorktreeAdminCommand,
  runWithGitWorktreeAdminLock
} from '../../../shared/git-worktree-admin-lock'
import type { GitOperationLease } from '../../../shared/git-operation-lock'
import type { GitAdmissionTier, GitExecOptions } from './git-exec-options'
import { resolveGitAdmissionTier } from './git-operation-executor'

const WORKTREE_ADMIN_LOCK_PRIORITY: Record<GitAdmissionTier, number> = {
  interactive: 2,
  status: 1,
  background: 0
}

export type GitExecLockGrant = {
  readonly lease: GitOperationLease
  /** Set when the command queued on the repo's worktree admin lane. */
  readonly worktreeAdminLockWaitMs?: number
}

/** Shared-metadata locks a git command must hold; `run` gets the grant when one applied. */
export function runWithGitExecLocks<T>(
  args: readonly string[],
  options: Pick<GitExecOptions, 'cwd' | 'signal' | 'admissionTier' | 'worktreeAdminLock'>,
  run: (grant?: GitExecLockGrant) => Promise<T>
): Promise<T> {
  const fetchHead = resolveGitFetchHeadCommand(args, options.cwd)
  if (fetchHead.needsLock) {
    return runWithGitFetchHeadLock(fetchHead.cwd, options.signal, () => run(), fetchHead.gitDir)
  }
  const adminCommand =
    options.worktreeAdminLock === false ? null : resolveGitWorktreeAdminCommand(args, options.cwd)
  if (!adminCommand) {
    return run()
  }
  const queuedAt = performance.now()
  // The admission tier already says who is waiting: a create runs interactive, pool warm-up does not.
  const priority = WORKTREE_ADMIN_LOCK_PRIORITY[resolveGitAdmissionTier(options.admissionTier)]
  return runWithGitWorktreeAdminLock(
    adminCommand,
    options.signal,
    (lease) => run({ lease, worktreeAdminLockWaitMs: performance.now() - queuedAt }),
    { priority }
  )
}
