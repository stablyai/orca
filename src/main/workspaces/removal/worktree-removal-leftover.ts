import { unregisteredFolderRefusal } from '../../../shared/worktree/removal/removal'
import { usesNativeWindowsRemoval } from '../../git/worktrees/removal/windows-worktree-removal'
import type { LocalProjectWorktreeGitOptions } from '../execution-host/project-runtime-git-options'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoveWorktreeResult } from '../../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { listWorktreesSharedStrict as listWorktreesStrict } from '../../git/worktrees/catalog/worktree-scan-cache'
import type { GitWorktreeExecOptions } from '../../git/worktrees/worktree-operation-options'
import {
  getErrorCode,
  normalizeLocalBranchRef
} from '../../git/worktrees/worktree-operation-options'
import type { WorktreeRemovalRecord } from './worktree-removal-records'
import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import { listWorktreesStrict as listUncachedWorktreesStrict } from '../../git/worktrees/catalog/worktree-listing'
import { failedWorktreeRemovals, worktreeCheckoutExists } from './worktree-removal-table'
import { waitForWorktreeRemovalAcceptance } from './worktree-removal-settlement'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath
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

export async function registeredRemovalCheckout(
  record: {
    repoPath: string
    worktreePath: string
  },
  options: GitWorktreeExecOptions = {}
): Promise<GitWorktreeInfo | undefined> {
  return (await listWorktreesStrict(record.repoPath, options)).find((worktree) =>
    areWorktreePathsEqual(worktree.path, record.worktreePath)
  )
}

export async function isCheckoutRegistered(
  record: {
    repoPath: string
    worktreePath: string
  },
  options: GitWorktreeExecOptions = {}
): Promise<boolean> {
  return !!(await registeredRemovalCheckout(record, options))
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

/** A leftover folder whose `.git` still names this repo's removed worktree entry, so a retry may delete it. */
export async function isProvenOrphanLeftover(
  repoPath: string,
  worktreePath: string
): Promise<boolean> {
  // Recorded (retryable) removals are host-only; WSL deletes never run in the background.
  if (isDangerousWorktreeRemovalPath(worktreePath, repoPath, CLIENT_REMOVAL_HOME)) {
    return false
  }
  // Recursive removal would follow a symlinked root into whatever it points at.
  if (!isRealDirectory(await lstat(worktreePath).catch(() => null))) {
    return false
  }
  return canSafelyRemoveOrphanedWorktreeDirectory(worktreePath, repoPath, CLIENT_REMOVAL_HOME)
}

/** lstat-style entry: a symlink never reads as a directory. */
function isRealDirectory(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') {
    return false
  }
  if ('type' in entry) {
    return entry.type === 'directory'
  }
  return (
    'isDirectory' in entry &&
    typeof entry.isDirectory === 'function' &&
    entry.isDirectory() === true
  )
}

/** Name nested worktrees first; refuse a leftover folder unless its `.git` proves it is this repo's. */
export async function assertUnregisteredLeftoverRemovable(
  repoPath: string,
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[]
): Promise<boolean> {
  if (!(await worktreeCheckoutExists(worktreePath))) {
    return false
  }
  assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
  if (!(await isProvenOrphanLeftover(repoPath, worktreePath))) {
    throw unregisteredFolderRefusal(worktreePath)
  }
  return true
}

/** Deletion-time check: Git still doesn't register the path or anything inside it, and `.git` still proves it. */
export async function isLeftoverStillRemovable(
  repoPath: string,
  record: WorktreeRemovalRecord,
  localOptions: LocalProjectWorktreeGitOptions,
  signal: AbortSignal
): Promise<boolean> {
  // Worktrees still being created count too: they hold files deletion must not touch.
  const current = await listUncachedWorktreesStrict(repoPath, {
    ...localOptions,
    includeCreatePreparations: true,
    signal
  })
  if (current.some((worktree) => areWorktreePathsEqual(worktree.path, record.worktreePath))) {
    throw differentCheckoutAtPathError(record.worktreePath)
  }
  return assertUnregisteredLeftoverRemovable(repoPath, record.worktreePath, current)
}

/** Registered paths use normal deletion; otherwise the folder must be gone or provably this repo's leftover. */
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
    await assertUnregisteredLeftoverRemovable(
      failed.repoPath,
      failed.worktreePath,
      registeredWorktrees
    )
  }
  if (retry() === undefined) {
    return false
  }
  await waitForWorktreeRemovalAcceptance(worktreeId)
  return true
}
