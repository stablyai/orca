import { realpath } from 'node:fs/promises'
import path from 'node:path'
import type { Store } from '../persistence'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { isFolderRepo } from '../../shared/repo-kind'
import type { Repo } from '../../shared/repo-types'
import type {
  WorkspaceCleanupTrashStrayDirectoryArgs,
  WorkspaceCleanupTrashStrayDirectoryResult
} from '../../shared/workspace-cleanup-stray-directories'
import { classifyWorkspaceCleanupStrayDirectory } from './workspace-cleanup-stray-directory-classifier'
import {
  planWorkspaceCleanupStrayRoots,
  type WorkspaceCleanupStrayRoot,
  type WorkspaceCleanupStrayStore
} from './workspace-cleanup-stray-directory-roots'
import {
  buildWorkspaceCleanupStrayGuard,
  listWorkspaceCleanupStrayParents,
  withCanonicalPaths
} from './workspace-cleanup-stray-directories'
import { listCleanupGitWorktrees } from './workspace-cleanup-worktree-listing'
import { mapWorkspaceCleanupWithConcurrency } from './workspace-cleanup-scan-primitives'

const MAX_PATH_LENGTH = 4096
const REPO_LIST_CONCURRENCY = 2

export type WorkspaceCleanupStrayTrashDeps = {
  /** Moves to the OS trash so the user can restore it; never a hard delete. */
  trashItem: (targetPath: string) => Promise<void>
  listRegisteredWorktreePaths: (repo: Repo) => Promise<string[]>
}

/**
 * Re-proves a folder is stray from fresh evidence, then moves it to the OS trash.
 *
 * Why re-prove: the path comes from the renderer and the scan that produced it may be minutes
 * old. The same root resolver, layout and classifier run again, so only a folder the scan itself
 * would report right now can be moved.
 */
export async function trashWorkspaceCleanupStrayDirectory(
  store: WorkspaceCleanupStrayStore,
  args: WorkspaceCleanupTrashStrayDirectoryArgs | undefined,
  deps: WorkspaceCleanupStrayTrashDeps
): Promise<WorkspaceCleanupTrashStrayDirectoryResult> {
  const requested = args?.path
  if (
    typeof requested !== 'string' ||
    requested.length === 0 ||
    requested.length > MAX_PATH_LENGTH ||
    requested.includes('\0') ||
    !path.isAbsolute(requested) ||
    path.basename(requested).startsWith('.')
  ) {
    return { ok: false, message: 'Invalid folder path.' }
  }
  const parentPath = await realpath(path.dirname(requested)).catch(() => null)
  if (!parentPath) {
    return { ok: false, message: 'Folder was not found.' }
  }
  const directoryPath = path.join(parentPath, path.basename(requested))
  const plan = planWorkspaceCleanupStrayRoots(store)
  const projectPaths = await withCanonicalPaths(plan.projectPaths)
  if (!(await isInsideWorktreeRootLayout(plan.roots, parentPath, projectPaths))) {
    return { ok: false, message: 'Folder is not inside a worktree folder Orca manages.' }
  }
  const localGitRepos = store
    .getRepos()
    .filter(
      (repo) => !isFolderRepo(repo) && getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
    )
  // Why tolerate a failed listing: the `.git` guard below already refuses any live checkout.
  const registered = await mapWorkspaceCleanupWithConcurrency(
    localGitRepos,
    REPO_LIST_CONCURRENCY,
    (repo) => deps.listRegisteredWorktreePaths(repo).catch(() => [])
  )
  const guard = buildWorkspaceCleanupStrayGuard([...registered.flat(), ...projectPaths])
  const verdict = await classifyWorkspaceCleanupStrayDirectory(directoryPath, guard, Date.now())
  if (!verdict.stray) {
    return { ok: false, message: 'Folder is no longer an unregistered leftover.' }
  }
  try {
    await deps.trashItem(directoryPath)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'Could not move the folder to the Trash.'
    }
  }
}

async function isInsideWorktreeRootLayout(
  roots: readonly WorkspaceCleanupStrayRoot[],
  parentPath: string,
  projectPaths: readonly string[]
): Promise<boolean> {
  const parentKey = path.resolve(parentPath)
  for (const root of roots) {
    const canonicalRoot = await realpath(root.path).catch(() => null)
    if (
      !canonicalRoot ||
      projectPaths.some((project) => isPathInsideOrEqual(canonicalRoot, project))
    ) {
      continue
    }
    for (const parent of await listWorkspaceCleanupStrayParents(root, canonicalRoot)) {
      if (path.resolve(parent.parentPath) === parentKey) {
        return true
      }
    }
  }
  return false
}

/** Default lister for the IPC handler: the same routed, timeout-guarded listing the scan uses. */
export async function listWorkspaceCleanupRegisteredWorktreePaths(
  store: Store,
  repo: Repo
): Promise<string[]> {
  const { gitWorktrees } = await listCleanupGitWorktrees(store, repo, false)
  return gitWorktrees.map((worktree) => worktree.path)
}
