import {
  CheckoutIdentityRefusal,
  differentCheckoutAtPathError,
  unregisteredFolderRefusal
} from '../../../shared/worktree/removal/removal'
import { usesNativeWindowsRemoval } from '../../git/worktrees/removal/windows-worktree-removal'
import type { LocalProjectWorktreeGitOptions } from '../execution-host/project-runtime-git-options'
import { lstat, readdir, rmdir } from 'node:fs/promises'
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
import {
  failedWorktreeRemovals,
  persistWorktreeRemovalRecords,
  worktreeCheckoutExists
} from './worktree-removal-table'
import type { LocalWorktreeFilesystemOptions } from './local-worktree-filesystem'
import { readCheckoutMarkerState } from './worktree-removal-gitdir-identity'
import { waitForWorktreeRemovalAcceptance } from './worktree-removal-settlement'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canSafelyRemoveOrphanedWorktreeDirectory,
  isDangerousWorktreeRemovalPath
} from './worktree-removal-safety'

export { CheckoutIdentityRefusal, differentCheckoutAtPathError }

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

/** A leftover whose `.git` names another admin entry is a different checkout restored at this path. */
export async function assertLeftoverIsRecordedCheckout(
  record: Pick<WorktreeRemovalRecord, 'worktreePath' | 'gitdir'>,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<void> {
  // A record without identity (written before it existed) cannot prove this folder is the one accepted; it stays listed.
  if (!record.gitdir) {
    throw new CheckoutIdentityRefusal(
      `Orca cannot confirm the folder at ${record.worktreePath} is the checkout you deleted, so it left it in place. Remove the folder yourself.`
    )
  }
  const current = await readCheckoutMarkerState(record.worktreePath, options)
  if (current.kind !== 'file' || current.identity !== record.gitdir) {
    throw differentCheckoutAtPathError(record.worktreePath)
  }
}

/** For a checkout Git or Windows may already have stripped of its marker: only a marker naming another checkout refuses. */
export async function assertCheckoutNotReplaced(
  record: Pick<WorktreeRemovalRecord, 'worktreePath' | 'gitdir'>,
  options: LocalWorktreeFilesystemOptions = {}
): Promise<void> {
  const current = await readCheckoutMarkerState(record.worktreePath, options)
  if (current.kind === 'absent') {
    return
  }
  if (!record.gitdir) {
    throw new CheckoutIdentityRefusal(
      `Orca cannot confirm the checkout at ${record.worktreePath} is the one you deleted, so it left it in place. Remove the folder yourself.`
    )
  }
  if (current.kind !== 'file' || current.identity !== record.gitdir) {
    throw differentCheckoutAtPathError(record.worktreePath)
  }
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

/**
 * An empty real directory holds nothing anyone could lose, so it needs no marker to prove whose it is:
 * Git can exit 0 and leave the emptied root, and a manual delete finishes that the same way.
 */
async function isEmptyLeftoverDirectory(repoPath: string, worktreePath: string): Promise<boolean> {
  if (isDangerousWorktreeRemovalPath(worktreePath, repoPath, CLIENT_REMOVAL_HOME)) {
    return false
  }
  if (!isRealDirectory(await lstat(worktreePath).catch(() => null))) {
    return false
  }
  return (await readdir(worktreePath).catch(() => null))?.length === 0
}

/** `rmdir` only: it fails rather than delete anything that appeared since the folder was found empty. */
export async function removeEmptyLeftoverDirectory(worktreePath: string): Promise<void> {
  try {
    await rmdir(worktreePath)
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return
    }
    if (getErrorCode(error) === 'ENOTEMPTY' || getErrorCode(error) === 'EEXIST') {
      throw unregisteredFolderRefusal(worktreePath)
    }
    throw error
  }
}

/** What an unregistered leftover may be removed as: a proven orphan, an empty folder, or nothing there. */
export type UnregisteredLeftover = 'orphan' | 'empty' | false

/** Name nested worktrees first; refuse a leftover folder unless its `.git` proves it is this repo's or it is empty. */
export async function assertUnregisteredLeftoverRemovable(
  repoPath: string,
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[]
): Promise<UnregisteredLeftover> {
  if (!(await worktreeCheckoutExists(worktreePath))) {
    return false
  }
  assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
  if (await isProvenOrphanLeftover(repoPath, worktreePath)) {
    return 'orphan'
  }
  if (await isEmptyLeftoverDirectory(repoPath, worktreePath)) {
    return 'empty'
  }
  throw unregisteredFolderRefusal(worktreePath)
}

/** Deletion-time check: Git still doesn't register the path or anything inside it, and `.git` still proves it. */
export async function isLeftoverStillRemovable(
  repoPath: string,
  record: WorktreeRemovalRecord,
  localOptions: LocalProjectWorktreeGitOptions,
  signal: AbortSignal
): Promise<UnregisteredLeftover> {
  // Worktrees still being created count too: they hold files deletion must not touch.
  const current = await listUncachedWorktreesStrict(repoPath, {
    ...localOptions,
    includeCreatePreparations: true,
    signal
  })
  if (current.some((worktree) => areWorktreePathsEqual(worktree.path, record.worktreePath))) {
    throw differentCheckoutAtPathError(record.worktreePath)
  }
  const removable = await assertUnregisteredLeftoverRemovable(
    repoPath,
    record.worktreePath,
    current
  )
  if (removable === 'orphan') {
    await assertLeftoverIsRecordedCheckout(record, localOptions)
  }
  return removable
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
  if (failed) {
    const native = usesNativeWindowsRemoval(worktreePath, localOptions)
    const leftover =
      !native &&
      (await assertUnregisteredLeftoverRemovable(
        failed.repoPath,
        failed.worktreePath,
        registeredWorktrees
      ))
    try {
      await (native
        ? assertCheckoutNotReplaced(failed, localOptions)
        : leftover === 'orphan' && assertLeftoverIsRecordedCheckout(failed, localOptions))
    } catch (error) {
      // The recorded intent no longer describes this folder; the next delete starts fresh instead of looping on the refusal.
      if (failed.gitdir && failedWorktreeRemovals.delete(worktreeId)) {
        void persistWorktreeRemovalRecords()
      }
      throw error
    }
  }
  if (retry() === undefined) {
    return false
  }
  await waitForWorktreeRemovalAcceptance(worktreeId)
  return true
}
