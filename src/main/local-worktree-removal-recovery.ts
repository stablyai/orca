import type { GitWorktreeInfo, RemoveWorktreeResult } from '../shared/types'
import {
  formatWorktreeRemovalError,
  isWindowsLongPathWorktreeRemovalError
} from './ipc/worktree-logic'
import { gitExecFileAsync } from './git/runner'
import type { GitWorktreeExecOptions } from './git/worktree'
import { removeLocalWorktreePath } from './local-worktree-filesystem'

type LocalWindowsLongPathRecoveryArgs = {
  error: unknown
  force: boolean
  canonicalWorktreePath: string
  repoPath: string
  localWorktreeGitOptions: GitWorktreeExecOptions
  registeredWorktree: Pick<GitWorktreeInfo, 'branch' | 'head'>
  deleteBranch: boolean
  closeWatcher: (worktreePath: string) => Promise<void>
}

type StaleLocalWorktreeRegistrationArgs = Omit<
  LocalWindowsLongPathRecoveryArgs,
  'error' | 'force' | 'closeWatcher'
>

function preservedBranchResult(
  registeredWorktree: Pick<GitWorktreeInfo, 'branch' | 'head'>,
  deleteBranch: boolean
): RemoveWorktreeResult {
  if (!deleteBranch || !registeredWorktree.branch || !registeredWorktree.head) {
    return {}
  }
  return {
    preservedBranch: {
      branchName: registeredWorktree.branch.replace(/^refs\/heads\//, ''),
      head: registeredWorktree.head
    }
  }
}

async function pruneRequiredGitWorktreeRegistration(
  repoPath: string,
  localWorktreeGitOptions: GitWorktreeExecOptions,
  canonicalWorktreePath: string
): Promise<void> {
  try {
    await gitExecFileAsync(['worktree', 'prune'], {
      cwd: repoPath,
      ...localWorktreeGitOptions
    })
  } catch (error) {
    throw new Error(
      `${formatWorktreeRemovalError(
        error,
        canonicalWorktreePath,
        true
      )} The worktree directory was removed, but Git still has stale worktree registration. Retry deletion after resolving the Git prune error.`
    )
  }
}

export async function recoverLocalWindowsLongPathWorktreeRemoval(
  args: LocalWindowsLongPathRecoveryArgs
): Promise<RemoveWorktreeResult | undefined> {
  if (!args.force || !isWindowsLongPathWorktreeRemovalError(args.error)) {
    return undefined
  }

  // Why: watcher shutdown is best-effort, but Git registration must be pruned
  // before callers clear Orca metadata or the branch remains locked.
  await args.closeWatcher(args.canonicalWorktreePath).catch(() => {})
  try {
    await removeLocalWorktreePath(args.canonicalWorktreePath, args.localWorktreeGitOptions)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, args.canonicalWorktreePath, true))
  }
  await pruneRequiredGitWorktreeRegistration(
    args.repoPath,
    args.localWorktreeGitOptions,
    args.canonicalWorktreePath
  )
  return preservedBranchResult(args.registeredWorktree, args.deleteBranch)
}

export async function pruneStaleLocalWorktreeRegistrationAfterFilesystemRemoval(
  args: StaleLocalWorktreeRegistrationArgs
): Promise<RemoveWorktreeResult> {
  await pruneRequiredGitWorktreeRegistration(
    args.repoPath,
    args.localWorktreeGitOptions,
    args.canonicalWorktreePath
  )
  return preservedBranchResult(args.registeredWorktree, args.deleteBranch)
}
