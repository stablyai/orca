import { unregisteredFolderRefusal } from '../shared/worktree/removal'
import { usesNativeWindowsRemoval } from './git/windows-worktree-removal'
import type { LocalProjectWorktreeGitOptions } from './project-runtime-git-options'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { listWorktreesStrict } from './git/worktree'
import { getErrorCode, normalizeLocalBranchRef } from './git/worktree-operation-options'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import { failedWorktreeRemovals, worktreeCheckoutExists } from './worktree-removal-table'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canSafelyRemoveOrphanedWorktreeDirectory
} from './worktree-removal-safety'

/** Absent .git or a proven orphan marker can identify a leftover; live or foreign registrations cannot. */
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

export function differentCheckoutAtPathError(worktreePath: string): Error {
  return new Error(
    `A different checkout is now at ${worktreePath}; Orca left it in place. Delete it again to remove it.`
  )
}

export async function registeredRemovalCheckout(record: {
  repoPath: string
  worktreePath: string
}): Promise<GitWorktreeInfo | undefined> {
  return (await listWorktreesStrict(record.repoPath)).find((worktree) =>
    areWorktreePathsEqual(worktree.path, record.worktreePath)
  )
}

export async function isCheckoutRegistered(record: {
  repoPath: string
  worktreePath: string
}): Promise<boolean> {
  return !!(await registeredRemovalCheckout(record))
}

export function isRecordedCheckout(
  worktree: GitWorktreeInfo,
  record: WorktreeRemovalRecord
): boolean {
  return (
    normalizeLocalBranchRef(worktree.branch) === record.branch &&
    (!record.head || worktree.head === record.head)
  )
}

export { unregisteredFolderRefusal } from '../shared/worktree/removal'

/** Name nested worktrees before asking the user to remove an unregistered folder. */
export async function assertUnregisteredCheckoutGone(
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[] = []
): Promise<void> {
  if (await worktreeCheckoutExists(worktreePath)) {
    assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
    throw unregisteredFolderRefusal(worktreePath)
  }
}

/** Registered paths use normal deletion; otherwise require the folder gone before retrying recorded cleanup. */
export async function retryFailedRemovalUnlessRegistered(
  worktreeId: string,
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[],
  localOptions: LocalProjectWorktreeGitOptions,
  retry: () => Promise<RemoveWorktreeResult> | undefined
): Promise<boolean> {
  if (registeredWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, worktreePath))) {
    return false
  }
  const failed = failedWorktreeRemovals.get(worktreeId)
  if (failed && !usesNativeWindowsRemoval(worktreePath, localOptions)) {
    await assertUnregisteredCheckoutGone(failed.worktreePath, registeredWorktrees)
  }
  return retry() !== undefined
}
