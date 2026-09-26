import { dirname, resolve } from 'node:path'
import { getGitRepoRoot, isGitRepo } from '../git/repo-detection'
import type { Store } from '../persistence'
import { getLocalFolderScopeRoots } from './filesystem-allowed-roots'

function comparableLocalPath(value: string): string {
  const normalized = resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

/** True only for the top level of a work tree, not for a plain directory inside one. */
export function isGitRepoRoot(path: string): boolean {
  return isGitRepo(path) && comparableLocalPath(getGitRepoRoot(path)) === comparableLocalPath(path)
}

/**
 * A git repo root that is a local folder-scope root (project group parent or folder workspace) or
 * sits directly inside one. Folder workspaces already authorize filesystem access to the whole
 * folder, so git access to the folder itself or its immediate child repos widens nothing; deeper
 * or non-git children stay denied.
 */
export function resolveFolderScopeGitRepoRoot(
  resolvedTarget: string,
  folderScopeRoots: readonly string[],
  isRepoRoot: (path: string) => boolean = isGitRepoRoot
): string | null {
  const target = comparableLocalPath(resolvedTarget)
  const parent = comparableLocalPath(dirname(resolvedTarget))
  if (parent === target) {
    return null
  }
  const isScopeRootOrImmediateChild = folderScopeRoots.some((root) => {
    const scopeRoot = comparableLocalPath(root)
    return scopeRoot === target || scopeRoot === parent
  })
  if (!isScopeRootOrImmediateChild || !isRepoRoot(resolvedTarget)) {
    return null
  }
  return resolvedTarget
}

export function resolveFolderScopeGitRepoRootForStore(
  resolvedTarget: string,
  store: Store
): string | null {
  return resolveFolderScopeGitRepoRoot(
    resolvedTarget,
    getLocalFolderScopeRoots(store, store.getRepos())
  )
}
