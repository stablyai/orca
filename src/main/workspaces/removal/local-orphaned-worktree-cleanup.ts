import { CheckoutIdentityRefusal } from '../../../shared/worktree/removal/removal'
import type { LocalWorktreeFilesystemOptions } from './local-worktree-filesystem'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePaths
} from './local-worktree-filesystem'
import { proveOrphanedCheckoutGuard } from './worktree-removal-gitdir-identity'
import { provesLocalOrphanedWorktree } from './local-orphaned-worktree-proof'
import {
  isWorktreePathMissing,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE
} from './worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from './worktree-removal-home-guard'
import { throwIfSignalAborted } from '../../../shared/concurrency/abort-signal-reason'

export async function cleanupLocalOrphanedWorktreeDirectory(
  repoPath: string,
  path: string,
  options: LocalWorktreeFilesystemOptions,
  closeWatchers: (path: string) => Promise<void>,
  signal?: AbortSignal,
  markerOptions: { expectedMarker?: string; forbidAnyMarker?: boolean } = {}
): Promise<void> {
  throwIfSignalAborted(signal)
  const access = getLocalWorktreePathAccess(options, path)
  const [runtimePath, runtimeRepoPath] = await toLocalWorktreeRuntimePaths(
    [path, repoPath],
    options,
    signal
  )
  const guard = await proveOrphanedCheckoutGuard(
    path,
    options,
    () =>
      provesLocalOrphanedWorktree(path, repoPath, options, CLIENT_REMOVAL_HOME, [
        runtimePath,
        runtimeRepoPath
      ]),
    markerOptions
  )
  throwIfSignalAborted(signal)
  if (guard) {
    await closeWatchers(path)
    throwIfSignalAborted(signal)
    await removeLocalWorktreePath(path, options, signal, guard).catch((error: unknown) => {
      throwIfSignalAborted(signal)
      if (error instanceof CheckoutIdentityRefusal) {
        throw error
      }
    })
  } else {
    console.warn(`[worktrees] Refusing recursive cleanup for unproven worktree directory: ${path}`)
  }
  if (!(await isWorktreePathMissing(runtimePath, access.statPath))) {
    throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
}
