import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { lstat, readdir } from '../asar-transparent-fs'
import { removeHostCheckout } from '../host-tree-removal'
import { parseWslPath } from '../wsl'
import { CLIENT_REMOVAL_HOME } from '../worktree-removal-home-guard'
import {
  assertWorktreeUnlockedForRemoval,
  unregisteredFolderRefusal
} from '../../shared/worktree/removal'
import {
  assertWorktreeDoesNotContainRegisteredWorktree,
  canSafelyRemoveOrphanedWorktreeDirectory,
  findRegisteredDeletableWorktree,
  isDangerousWorktreeRemovalPath,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE
} from '../worktree-removal-safety'
import { readTranslatedWorktreeGraph } from './worktree-list-reader'
import { assertWorktreeCleanForRemoval } from './worktree-removal-preflight'
import { getErrorCode, type RemoveWorktreeOptions } from './worktree-operation-options'

export function usesNativeWindowsRemoval(path: string, options: { wslDistro?: string }): boolean {
  return process.platform === 'win32' && !options.wslDistro && !parseWslPath(path)
}

export async function nativeWindowsMarkerMissing(
  path: string,
  options: { wslDistro?: string }
): Promise<boolean> {
  if (!usesNativeWindowsRemoval(path, options)) {
    return false
  }
  try {
    await lstat(join(path, '.git'))
    return false
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return true
    }
    throw error
  }
}

/** Called inside the destructive slot, after teardown; every pass rederives authority from Git/disk. */
export async function removeWindowsCheckout(
  repo: string,
  root: string,
  force: boolean,
  options: RemoveWorktreeOptions
): Promise<void> {
  await removeHostCheckout(
    root,
    (checkClean) => authorizeWindowsCheckout(repo, root, force, options, false, checkClean),
    options.checkoutDeleteSignal
  )
}

/** Share ordinary refusal before either entrypoint publishes a retry or tears down resources. */
export async function authorizeUnregisteredWindowsRemoval(
  registered: boolean,
  repo: string,
  root: string,
  force: boolean,
  options: RemoveWorktreeOptions
): Promise<void> {
  if (!registered && usesNativeWindowsRemoval(root, options)) {
    await authorizeWindowsCheckout(
      repo,
      root,
      force,
      { ...options, knownRemovedWorktree: null },
      true
    )
  }
}

/** Read-only eligibility before teardown; destructive admission always repeats it after waits. */
export async function authorizeWindowsCheckout(
  repo: string,
  root: string,
  force: boolean,
  options: RemoveWorktreeOptions & Parameters<typeof assertWorktreeCleanForRemoval>[2],
  beforeTeardown = false,
  checkClean = true
): Promise<boolean> {
  const worktrees = await readTranslatedWorktreeGraph(repo, options)
  const current = findRegisteredDeletableWorktree(repo, root, worktrees, CLIENT_REMOVAL_HOME)
  if (isDangerousWorktreeRemovalPath(root, repo, CLIENT_REMOVAL_HOME)) {
    throw new Error(`Refusing to delete protected worktree path: ${root}`)
  }
  // The unregistered route needs the same fresh nested-worktree refusal.
  if (!current) {
    assertWorktreeDoesNotContainRegisteredWorktree(root, worktrees)
  }
  assertWorktreeUnlockedForRemoval(current ?? undefined)
  const expected = options.knownRemovedWorktree
  if (
    current &&
    (expected === null ||
      (expected &&
        (current.branch !== expected.branch || (expected.head && current.head !== expected.head))))
  ) {
    throw new Error(
      `A different checkout is now at ${root}; Orca left it in place. Delete it again to remove it.`
    )
  }
  let entry
  try {
    entry = await lstat(root)
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return false
    }
    throw error
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Refusing to delete unregistered worktree path: ${root}`)
  }
  if (await nativeWindowsMarkerMissing(root, options)) {
    // Reject only; an empty observation never authorizes recursive deletion after teardown.
    if (beforeTeardown && (await readdir(root)).length > 0) {
      throw unregisteredFolderRefusal(root)
    }
    return false
  }
  if (!(await canSafelyRemoveOrphanedWorktreeDirectory(root, repo, CLIENT_REMOVAL_HOME))) {
    throw new Error(`Refusing to delete unregistered worktree path: ${root}`)
  }
  if (!current && !force) {
    throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
  const marker = join(root, '.git')
  const admin = resolve(
    root,
    (await readFile(marker, 'utf8'))
      .split(/\r?\n/, 1)[0]
      .trim()
      .replace(/^gitdir:\s*/i, '')
  )
  try {
    await lstat(join(admin, 'locked'))
    throw new Error('Cannot remove a locked worktree. Unlock it before deleting.')
  } catch (error) {
    if (getErrorCode(error) !== 'ENOENT') {
      throw error
    }
  }
  if (checkClean && !force) {
    await assertWorktreeCleanForRemoval(root, force, options, admin)
    return authorizeWindowsCheckout(repo, root, force, options, beforeTeardown, false)
  }
  return true
}
