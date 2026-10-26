import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import { pruneGitWorktrees } from './git/worktree-prune-guard'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../shared/worktree/removal'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { formatWorktreeRemovalError } from './ipc/worktree-logic'
import { listWorktreesStrict, type GitWorktreeExecOptions } from './git/worktree'
import { removeLocalWorktreePath } from './local-worktree-filesystem'

type LocalWindowsRemovalRecoveryArgs = {
  error: unknown
  force: boolean
  canonicalWorktreePath: string
  repoPath: string
  localWorktreeGitOptions: GitWorktreeExecOptions
  registeredWorktree: Pick<GitWorktreeInfo, 'branch' | 'head' | 'locked' | 'lockReason'>
  deleteBranch: boolean
  closeWatcher: (worktreePath: string) => Promise<void>
  signal?: AbortSignal
}

type StaleLocalWorktreeRegistrationArgs = Omit<
  LocalWindowsRemovalRecoveryArgs,
  'error' | 'force' | 'closeWatcher' | 'signal'
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

function staleRegistrationRecoveryError(
  error: unknown,
  canonicalWorktreePath: string,
  force: boolean
): Error {
  return new Error(
    `${formatWorktreeRemovalError(
      error,
      canonicalWorktreePath,
      force
    )} Git still has stale worktree registration. Retry deletion after resolving the Git registration error.`
  )
}

async function verifyGitWorktreeRegistrationRemoved(
  repoPath: string,
  localWorktreeGitOptions: GitWorktreeExecOptions,
  canonicalWorktreePath: string,
  force: boolean
): Promise<void> {
  try {
    const remainingWorktrees = await listWorktreesStrict(repoPath, localWorktreeGitOptions)
    if (
      remainingWorktrees.some((worktree) =>
        areWorktreePathsEqual(worktree.path, canonicalWorktreePath)
      )
    ) {
      throw new Error('Git still reports the worktree registration after cleanup.')
    }
  } catch (error) {
    throw staleRegistrationRecoveryError(error, canonicalWorktreePath, force)
  }
}

async function removeRequiredGitWorktreeRegistration(
  args: StaleLocalWorktreeRegistrationArgs,
  forceForError = true
): Promise<RemoveWorktreeResult> {
  assertWorktreeUnlockedForRemoval(args.registeredWorktree)

  let result: RemoveWorktreeResult | undefined
  let removalError: unknown
  try {
    await pruneGitWorktrees({ cwd: args.repoPath, ...args.localWorktreeGitOptions })
    result = preservedBranchResult(args.registeredWorktree, args.deleteBranch)
  } catch (error) {
    removalError = error
  }

  // Successful prune can retain locked registrations; verify the row is gone.
  try {
    await verifyGitWorktreeRegistrationRemoved(
      args.repoPath,
      args.localWorktreeGitOptions,
      args.canonicalWorktreePath,
      forceForError
    )
  } catch (verificationError) {
    throw removalError
      ? staleRegistrationRecoveryError(removalError, args.canonicalWorktreePath, forceForError)
      : verificationError
  }
  // Preserve the branch when Git may have detached the row before reporting a filesystem error.
  return result ?? preservedBranchResult(args.registeredWorktree, args.deleteBranch)
}

export async function recoverLocalWindowsWorktreeRemoval(
  args: LocalWindowsRemovalRecoveryArgs
): Promise<RemoveWorktreeResult | undefined> {
  // Reject Git locks before recovery can recursively delete files.
  assertWorktreeUnlockedForRemoval(args.registeredWorktree)

  if (!(await isRecoverableWindowsFilesystemRemovalFailure(args))) {
    return undefined
  }

  // Release watcher handles before recursively finishing Git’s partial removal; abort if closing fails.
  await args.closeWatcher(args.canonicalWorktreePath)
  try {
    await removeLocalWorktreePath(
      args.canonicalWorktreePath,
      args.localWorktreeGitOptions,
      args.signal
    )
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, args.canonicalWorktreePath, args.force))
  }
  return removeRequiredGitWorktreeRegistration(args, args.force)
}

async function isRecoverableWindowsFilesystemRemovalFailure(
  args: LocalWindowsRemovalRecoveryArgs
): Promise<boolean> {
  if (process.platform !== 'win32' || typeof args.error !== 'object' || args.error === null) {
    return false
  }

  try {
    const worktrees = await listWorktreesStrict(args.repoPath, args.localWorktreeGitOptions)
    // Localized error text cannot prove removal started; require the Git row to be absent.
    return !worktrees.some((worktree) =>
      areWorktreePathsEqual(worktree.path, args.canonicalWorktreePath)
    )
  } catch {
    return false
  }
}

export async function removeStaleLocalWorktreeRegistration(
  args: StaleLocalWorktreeRegistrationArgs
): Promise<RemoveWorktreeResult> {
  return removeRequiredGitWorktreeRegistration(args)
}
