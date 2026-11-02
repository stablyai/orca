import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import { pruneGitWorktrees } from './git/worktree-prune-guard'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../shared/worktree/removal'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { formatWorktreeRemovalError, isOrphanedWorktreeError } from './ipc/worktree-logic'
import { listWorktreesStrict, type GitWorktreeExecOptions } from './git/worktree'
import { normalizeLocalBranchRef } from './git/worktree-operation-options'
import { deleteBranchOfUnregisteredWorktree } from './git/worktree-removal'
import { removeLocalWorktreePath } from './local-worktree-filesystem'
import { assertWorktreeDoesNotContainRegisteredWorktree } from './worktree-removal-safety'

type LocalPartialRemovalRecoveryArgs = {
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
  LocalPartialRemovalRecoveryArgs,
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

function staleRegistrationRecoveryError(error: unknown, canonicalWorktreePath: string): Error {
  return new Error(
    `${formatWorktreeRemovalError(
      error,
      canonicalWorktreePath,
      true
    )} Git still has stale worktree registration. Retry deletion after resolving the Git registration error.`
  )
}

async function verifyGitWorktreeRegistrationRemoved(
  repoPath: string,
  localWorktreeGitOptions: GitWorktreeExecOptions,
  canonicalWorktreePath: string
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
    throw staleRegistrationRecoveryError(error, canonicalWorktreePath)
  }
}

export async function removeStaleLocalWorktreeRegistration(
  args: StaleLocalWorktreeRegistrationArgs
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
      args.canonicalWorktreePath
    )
  } catch (verificationError) {
    throw removalError
      ? staleRegistrationRecoveryError(removalError, args.canonicalWorktreePath)
      : verificationError
  }
  // Preserve the branch when Git may have detached the row before reporting a filesystem error.
  return result ?? preservedBranchResult(args.registeredWorktree, args.deleteBranch)
}

export async function recoverPartialLocalWorktreeRemoval(
  args: LocalPartialRemovalRecoveryArgs
): Promise<RemoveWorktreeResult | undefined> {
  // Reject Git locks before recovery can recursively delete files.
  assertWorktreeUnlockedForRemoval(args.registeredWorktree)

  if (!(await isRecoverablePartialRemovalFailure(args))) {
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
  const { branch, head } = args.registeredWorktree
  // Same -d policy as a normal delete: merged branches go, unmerged ones are preserved.
  return deleteBranchOfUnregisteredWorktree(
    args.repoPath,
    args.canonicalWorktreePath,
    args.deleteBranch && branch ? { name: normalizeLocalBranchRef(branch), head } : null,
    args.localWorktreeGitOptions
  )
}

async function isRecoverablePartialRemovalFailure(
  args: LocalPartialRemovalRecoveryArgs
): Promise<boolean> {
  // Leave English orphan errors (Git refused before deleting) to the proven-orphan cleanup.
  if (
    typeof args.error !== 'object' ||
    args.error === null ||
    isOrphanedWorktreeError(args.error)
  ) {
    return false
  }

  let worktrees: GitWorktreeInfo[]
  try {
    worktrees = await listWorktreesStrict(args.repoPath, args.localWorktreeGitOptions)
  } catch {
    return false
  }
  // Localized error text cannot prove removal started; require the Git row to be absent.
  if (
    worktrees.some((worktree) => areWorktreePathsEqual(worktree.path, args.canonicalWorktreePath))
  ) {
    return false
  }
  // A worktree registered inside the checkout during Git's delete must not be removed with it.
  assertWorktreeDoesNotContainRegisteredWorktree(args.canonicalWorktreePath, worktrees)
  return true
}
