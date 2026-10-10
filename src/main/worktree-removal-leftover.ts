import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { listWorktreesStrict } from './git/worktree'
import { getErrorCode } from './git/worktree-operation-options'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import {
  failedWorktreeRemovals,
  persistWorktreeRemovalRecords,
  worktreeCheckoutExists
} from './worktree-removal-table'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canSafelyRemoveOrphanedWorktreeDirectory
} from './worktree-removal-safety'

/**
 * Whether a checkout path Git no longer registers still holds the removed checkout's own leftover:
 * no `.git` (Git deleted it first), or a `.git` file naming the admin entry Git removed. Any other
 * `.git` is a different checkout created at the path since.
 */
export async function isUnregisteredRemovalLeftover(
  repoPath: string,
  worktreePath: string
): Promise<boolean> {
  try {
    await lstat(join(worktreePath, '.git'))
  } catch (error) {
    return getErrorCode(error) === 'ENOENT'
  }
  return canSafelyRemoveOrphanedWorktreeDirectory(worktreePath, repoPath, CLIENT_REMOVAL_HOME)
}

/** The refusal when the path no longer holds the removed checkout's own leftover. */
export function differentCheckoutAtPathError(worktreePath: string): Error {
  return new Error(
    `A different checkout is now at ${worktreePath}; Orca left it in place. Delete it again to remove it.`
  )
}

/** Whether Git registers a checkout at the recorded path now. */
export async function isCheckoutRegistered(record: {
  repoPath: string
  worktreePath: string
}): Promise<boolean> {
  return (await listWorktreesStrict(record.repoPath)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, record.worktreePath)
  )
}

/**
 * The refusal for a folder Git no longer registers: Orca deletes a checkout only through Git, so
 * the user removes the folder, and the listing drops the workspace once it is gone.
 */
export function unregisteredFolderRefusal(worktreePath: string): Error {
  return new Error(
    `Git no longer tracks ${worktreePath}, so Orca won't delete it. Remove the folder yourself, and Orca will drop this workspace from the list.`
  )
}

/**
 * Refuses while anything is at a checkout path Git no longer registers, naming first any worktree
 * in `registeredWorktrees` inside it.
 */
export async function assertUnregisteredCheckoutGone(
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[] = []
): Promise<void> {
  if (await worktreeCheckoutExists(worktreePath)) {
    // Why first: removing the folder, as the refusal asks, would delete that worktree's files too.
    assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
    throw unregisteredFolderRefusal(worktreePath)
  }
}

/**
 * Delete's choice for a workspace whose earlier delete failed, from Git's listing taken now: a
 * checkout Git registers at the path again is the normal delete's, so the failed record is dropped;
 * a folder Git does not register is refused, the record kept; with the folder gone, `retry` runs
 * or joins the recorded removal to finish the rest. True then.
 */
export async function retryFailedRemovalUnlessRegistered(
  worktreeId: string,
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[],
  retry: () => Promise<RemoveWorktreeResult> | undefined
): Promise<boolean> {
  if (registeredWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, worktreePath))) {
    if (failedWorktreeRemovals.delete(worktreeId)) {
      void persistWorktreeRemovalRecords()
    }
    return false
  }
  const failed = failedWorktreeRemovals.get(worktreeId)
  if (failed) {
    await assertUnregisteredCheckoutGone(failed.worktreePath, registeredWorktrees)
  }
  return retry() !== undefined
}
