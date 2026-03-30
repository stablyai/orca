import { realpath } from 'fs/promises'
import { resolve, relative, dirname, basename, isAbsolute } from 'path'
import type { Store } from '../persistence'
import { listWorktrees } from '../git/worktree'

export const PATH_ACCESS_DENIED_MESSAGE =
  'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'

/**
 * Check whether resolvedTarget is equal to or a descendant of resolvedBase.
 * Uses relative() so it works with both `/` (Unix) and `\` (Windows) separators.
 */
export function isDescendantOrEqual(resolvedTarget: string, resolvedBase: string): boolean {
  if (resolvedTarget === resolvedBase) {
    return true
  }
  const rel = relative(resolvedBase, resolvedTarget)
  // rel must not start with ".." and must not be an absolute path (e.g. different drive on Windows)
  // [Security Fix]: Added !isAbsolute(rel) to prevent drive traversal bypasses on Windows
  // where relative('D:\\repo', 'C:\\etc\\passwd') returns absolute path 'C:\\etc\\passwd'
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    !isAbsolute(rel) &&
    resolve(resolvedBase, rel) === resolvedTarget
  )
}

export function getAllowedRoots(store: Store): string[] {
  const roots = store.getRepos().map((repo) => resolve(repo.path))
  const workspaceDir = store.getSettings().workspaceDir
  if (workspaceDir) {
    roots.push(resolve(workspaceDir))
  }
  return roots
}

export function isPathAllowed(targetPath: string, store: Store): boolean {
  const resolvedTarget = resolve(targetPath)
  return getAllowedRoots(store).some((root) => isDescendantOrEqual(resolvedTarget, root))
}

/**
 * Returns true if the error is an ENOENT (file-not-found) error.
 */
export function isENOENT(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

export async function resolveAuthorizedPath(targetPath: string, store: Store): Promise<string> {
  const resolvedTarget = resolve(targetPath)
  if (!isPathAllowed(resolvedTarget, store)) {
    throw new Error(PATH_ACCESS_DENIED_MESSAGE)
  }

  try {
    const realTarget = await realpath(resolvedTarget)
    if (!isPathAllowed(realTarget, store)) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return realTarget
  } catch (error) {
    if (!isENOENT(error)) {
      throw error
    }

    const realParent = await realpath(dirname(resolvedTarget))
    const candidateTarget = resolve(realParent, basename(resolvedTarget))
    if (!isPathAllowed(candidateTarget, store)) {
      throw new Error(PATH_ACCESS_DENIED_MESSAGE)
    }
    return candidateTarget
  }
}

async function normalizeExistingPath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath)
  } catch {
    return resolve(targetPath)
  }
}

export async function resolveRegisteredWorktreePath(
  worktreePath: string,
  store: Store
): Promise<string> {
  const resolvedPath = await resolveAuthorizedPath(worktreePath, store)

  for (const repo of store.getRepos()) {
    const normalizedRepoPath = await normalizeExistingPath(repo.path)

    if (resolvedPath === normalizedRepoPath) {
      return resolvedPath
    }

    const worktrees = await listWorktrees(repo.path)
    for (const worktree of worktrees) {
      const normalizedWorktreePath = await normalizeExistingPath(worktree.path)
      if (resolvedPath === normalizedWorktreePath) {
        return resolvedPath
      }
    }
  }

  throw new Error('Access denied: unknown repository or worktree path')
}

export function validateGitRelativeFilePath(worktreePath: string, filePath: string): string {
  if (!filePath || filePath.includes('\0') || resolve(filePath) === filePath) {
    throw new Error('Access denied: invalid git file path')
  }

  const resolvedFilePath = resolve(worktreePath, filePath)
  if (!isDescendantOrEqual(resolvedFilePath, worktreePath)) {
    throw new Error('Access denied: git file path escapes the selected worktree')
  }

  const normalizedRelativePath = relative(worktreePath, resolvedFilePath)
  if (!normalizedRelativePath) {
    throw new Error('Access denied: invalid git file path')
  }

  return normalizedRelativePath
}
