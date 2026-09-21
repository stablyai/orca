import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import { isSubmoduleWorktreeRemovalRefusal } from '../../shared/worktree/submodule-removal'
import { withWorktreeRemoveStageSpan } from '../observability/instrumentation'
import { withSpan } from '../observability/tracer'
import {
  moveWorktreeDirectoryToTrash,
  restoreWorktreeDirectoryFromTrash,
  scheduleWorktreeTrashDeletion
} from '../worktree-trash'
import { parseWslPath } from '../wsl'
import { gitExecFileAsync } from './runner'
import { runWithGitReadCacheInvalidation } from './status'
import { deleteBranchAfterWorktreeRemoval } from './worktree-branch-removal'
import { listWorktreesStrict } from './worktree-listing'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import type { RemoveWorktreeOptions } from './worktree-operation-options'
import {
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  gitExecOptions,
  normalizeLocalBranchRef
} from './worktree-operation-options'
import { areWorktreePathsEqual } from './worktree-path-comparison'
import { assertWorktreeCleanForRemoval } from './worktree-removal-preflight'
import { withRepoRefMaintenancePaused } from './local-repo-ref-maintenance'
import { bumpWorktreeScanGeneration, listWorktrees } from './worktree-scan-cache'
import { invalidateSparseCheckoutState } from './worktree-sparse-checkout-cache'

/**
 * Remove a worktree.
 */
export async function removeWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  // forceBranchDelete: for failed-creation rollback (fresh branch, no user work); user deletes leave it false so unmerged commits survive.
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  try {
    // Removal deletes branches, and a ref deletion needs the packed-refs lock a
    // running idle pack holds while it rewrites. Waits that window out; the
    // prune phase that follows it is concurrency-safe and is left to finish.
    return await withRepoRefMaintenancePaused('worktree-remove', () =>
      runWithGitReadCacheInvalidation(() =>
        performRemoveWorktree(repoPath, worktreePath, force, options)
      )
    )
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
    invalidateSparseCheckoutState(repoPath, worktreePath)
    bumpWorktreeScanGeneration(repoPath)
  }
}

async function performRemoveWorktree(
  repoPath: string,
  worktreePath: string,
  force = false,
  options: RemoveWorktreeOptions = {}
): Promise<RemoveWorktreeResult> {
  const removedWorktree =
    options.knownRemovedWorktree ??
    (await listWorktrees(repoPath, options)).find((worktree) =>
      areWorktreePathsEqual(worktree.path, worktreePath)
    )
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')
  const branchHead = removedWorktree?.head ?? ''

  // Why: callers outside the IPC/runtime preflight must not bypass Git's lock contract or rely on localized stderr after side effects.
  assertWorktreeUnlockedForRemoval(removedWorktree)

  if (
    !(await tryRemoveWorktreeWithDeferredDirectoryDeletion(repoPath, worktreePath, force, options))
  ) {
    const args = ['worktree', 'remove']
    if (force) {
      args.push('--force')
    }
    args.push(worktreePath)
    try {
      await gitExecFileAsync(args, gitExecOptions(repoPath, options))
    } catch (error) {
      if (force || !isSubmoduleWorktreeRemovalRefusal(error)) {
        throw error
      }
      // Why: Git refuses non-force removal of a worktree with an initialised submodule even when clean; re-prove cleanliness, then --force.
      await assertWorktreeCleanForRemoval(worktreePath, false, options)
      await gitExecFileAsync(
        ['worktree', 'remove', '--force', worktreePath],
        gitExecOptions(repoPath, options)
      )
    }
  }

  if (!branchName) {
    return {}
  }
  if (options.deleteBranch === false) {
    return {}
  }

  // Why its own span: branch cleanup can reach the network (`fetch --prune`), so a stall here reads as
  // `git worktree remove` being slow unless it is timed separately.
  return withSpan('worktree.remove.branch_delete', () =>
    deleteBranchAfterWorktreeRemoval(repoPath, branchName, branchHead, options)
  )
}

/**
 * Rename the checkout into a sibling trash directory and clear Git's registration for the
 * now-missing path, so the multi-GB recursive delete runs after this removal has returned.
 * Returns false when the caller must let `git worktree remove` delete the directory inline.
 */
async function tryRemoveWorktreeWithDeferredDirectoryDeletion(
  repoPath: string,
  worktreePath: string,
  force: boolean,
  options: RemoveWorktreeOptions
): Promise<boolean> {
  // Why: WSL-owned checkouts are deleted inside the distro, so Node on Windows must not rename them.
  if (options.wslDistro || parseWslPath(worktreePath)) {
    return false
  }
  if (!force) {
    try {
      // Why: `git worktree remove` re-checks cleanliness as it removes; prove the same thing here or leave removal to Git.
      await assertWorktreeCleanForRemoval(worktreePath, false, options)
    } catch {
      return false
    }
  }

  const trashPath = await withWorktreeRemoveStageSpan('trash_rename', 'local', () =>
    moveWorktreeDirectoryToTrash(worktreePath)
  )
  if (!trashPath) {
    return false
  }
  try {
    await clearGitRegistrationForMissingWorktree(repoPath, worktreePath, options)
  } catch (error) {
    // Why: put the checkout back so the in-place removal below still sees the worktree Git registered.
    if (await restoreWorktreeDirectoryFromTrash(trashPath, worktreePath)) {
      return false
    }
    throw error
  }
  scheduleWorktreeTrashDeletion(trashPath)
  return true
}

async function clearGitRegistrationForMissingWorktree(
  repoPath: string,
  worktreePath: string,
  options: RemoveWorktreeOptions
): Promise<void> {
  const registrationOptions = {
    ...options,
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
  try {
    // Removing an already-missing directory is accepted back to the Git 2.25 baseline and touches only this entry.
    await gitExecFileAsync(
      ['worktree', 'remove', '--force', worktreePath],
      gitExecOptions(repoPath, registrationOptions)
    )
    return
  } catch (error) {
    console.warn(
      `[git] Failed to deregister the moved worktree "${worktreePath}"; pruning instead`,
      error
    )
  }

  await gitExecFileAsync(['worktree', 'prune'], gitExecOptions(repoPath, registrationOptions))
  // Strict (not the shared scan): an unreadable repo must not read as proof that the row is gone.
  const stillRegistered = (await listWorktreesStrict(repoPath, registrationOptions)).some(
    (worktree) => areWorktreePathsEqual(worktree.path, worktreePath)
  )
  if (stillRegistered) {
    throw new Error(`Git still reports a registration for "${worktreePath}" after pruning it.`)
  }
}
