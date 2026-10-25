import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath,
  type LocalWorktreeFilesystemOptions
} from './local-worktree-filesystem'
import { isProvenLocalWorktreeRemovalLeftover } from './local-orphaned-worktree-cleanup'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { listWorktreesStrict } from './git/worktree'
import { getErrorCode } from './git/worktree-operation-options'
import { areWorktreePathsEqual } from './git/worktree-path-comparison'
import { getPathOps } from './worktree-removal-home-guard'
import {
  failedWorktreeRemovals,
  persistWorktreeRemovalRecords,
  worktreeCheckoutExists
} from './worktree-removal-table'
import { assertWorktreeDoesNotContainRegisteredWorktree } from './worktree-removal-safety'

/** Absent .git or a proven orphan marker can identify a leftover; live or foreign registrations cannot. */
export async function isUnregisteredRemovalLeftover(
  repoPath: string,
  worktreePath: string,
  localOptions: LocalWorktreeFilesystemOptions = {}
): Promise<boolean> {
  const runtimePath = toLocalWorktreeRuntimePath(worktreePath, localOptions)
  try {
    await getLocalWorktreePathAccess(localOptions).statPath(
      getPathOps(runtimePath).join(runtimePath, '.git')
    )
  } catch (error) {
    const code = getErrorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return true
    }
    throw error
  }
  return isProvenLocalWorktreeRemovalLeftover(repoPath, worktreePath, localOptions)
}

export function differentCheckoutAtPathError(worktreePath: string): Error {
  return new Error(
    `A different checkout is now at ${worktreePath}; Orca left it in place. Delete it again to remove it.`
  )
}

export async function isCheckoutRegistered(
  record: { repoPath: string; worktreePath: string },
  localOptions: LocalWorktreeFilesystemOptions = {}
): Promise<boolean> {
  return (await listWorktreesStrict(record.repoPath, localOptions)).some((worktree) =>
    areWorktreePathsEqual(worktree.path, record.worktreePath)
  )
}

export function unregisteredFolderRefusal(worktreePath: string): Error {
  return new Error(
    `${worktreePath} is no longer a Git worktree, so its folder was left on disk. Delete the folder yourself to finish removing this workspace.`
  )
}

/** Name nested worktrees before asking the user to remove an unregistered folder. */
export async function assertUnregisteredCheckoutGone(
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[] = [],
  localOptions: LocalWorktreeFilesystemOptions = {}
): Promise<void> {
  if (await worktreeCheckoutExists(worktreePath, localOptions)) {
    assertWorktreeDoesNotContainRegisteredWorktree(worktreePath, registeredWorktrees)
    throw unregisteredFolderRefusal(worktreePath)
  }
}

/** Retry proven orphan links; unknown folders must be removed by their owner first. */
export async function retryFailedRemovalUnlessRegistered(
  worktreeId: string,
  worktreePath: string,
  registeredWorktrees: readonly Pick<GitWorktreeInfo, 'path'>[],
  retry: () => Promise<RemoveWorktreeResult> | undefined,
  localOptions: LocalWorktreeFilesystemOptions = {}
): Promise<boolean> {
  if (registeredWorktrees.some((worktree) => areWorktreePathsEqual(worktree.path, worktreePath))) {
    if (failedWorktreeRemovals.delete(worktreeId)) {
      void persistWorktreeRemovalRecords()
    }
    return false
  }
  const failed = failedWorktreeRemovals.get(worktreeId)
  if (failed) {
    assertWorktreeDoesNotContainRegisteredWorktree(failed.worktreePath, registeredWorktrees)
    if (
      !(await isProvenLocalWorktreeRemovalLeftover(
        failed.repoPath,
        failed.worktreePath,
        localOptions
      ))
    ) {
      await assertUnregisteredCheckoutGone(failed.worktreePath, registeredWorktrees, localOptions)
    }
  }
  return retry() !== undefined
}
