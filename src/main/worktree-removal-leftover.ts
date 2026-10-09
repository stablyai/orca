import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { listWorktreesStrict } from './git/worktree'
import { getErrorCode } from './git/worktree-operation-options'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canSafelyRemoveOrphanedWorktreeDirectory
} from './worktree-removal-safety'
import type { GitWorktreeExecOptions } from './git/worktree-operation-options'

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
/** A retry found a checkout at the path that is not the one its removal was for. */
export class DifferentCheckoutAtPathError extends Error {}

export function differentCheckoutAtPathError(worktreePath: string): Error {
  return new DifferentCheckoutAtPathError(
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
 * Refuses unless the path still holds the removed checkout's own leftover, with no worktree Git
 * registers at or inside it. Run right before the delete: the path can change while it waits.
 */
export async function assertUnregisteredRemovalLeftover(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  const worktrees = await listWorktreesStrict(repoPath, options)
  if (worktrees.some((worktree) => areWorktreePathsEqual(worktree.path, worktreePath))) {
    throw differentCheckoutAtPathError(worktreePath)
  }
  assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, worktrees)
  if (!(await isUnregisteredRemovalLeftover(repoPath, worktreePath))) {
    throw differentCheckoutAtPathError(worktreePath)
  }
}
