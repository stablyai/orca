import { lstat } from 'fs/promises'
import { homedir } from 'os'
import { posix, win32 } from 'path'
import type { GitWorktreeInfo } from '../shared/types'
import { areWorktreePathsEqual } from './ipc/worktree-logic'

type PathOps = typeof posix

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

function getPathOps(...paths: string[]): PathOps {
  return paths.some(looksLikeWindowsPath) ? win32 : posix
}

function containsPath(parentPath: string, childPath: string, pathOps: PathOps): boolean {
  const relativePath = pathOps.relative(parentPath, childPath)
  return (
    relativePath === '' ||
    (!!relativePath && !relativePath.startsWith('..') && !pathOps.isAbsolute(relativePath))
  )
}

export function isDangerousWorktreeRemovalPath(worktreePath: string, repoPath: string): boolean {
  if (!worktreePath.trim()) {
    return true
  }

  if (areWorktreePathsEqual(worktreePath, repoPath)) {
    return true
  }

  const pathOps = getPathOps(worktreePath, repoPath)
  const resolvedWorktreePath = pathOps.resolve(worktreePath)
  const rootPath = pathOps.parse(resolvedWorktreePath).root
  if (resolvedWorktreePath === rootPath) {
    return true
  }

  const resolvedRepoPath = pathOps.resolve(repoPath)
  if (containsPath(resolvedWorktreePath, resolvedRepoPath, pathOps)) {
    return true
  }

  const homePath = homedir()
  return !!homePath && containsPath(resolvedWorktreePath, pathOps.resolve(homePath), pathOps)
}

export function getRegisteredDeletableWorktree(
  repoPath: string,
  requestedWorktreePath: string,
  worktrees: readonly GitWorktreeInfo[]
): GitWorktreeInfo {
  const worktree = worktrees.find((item) => areWorktreePathsEqual(item.path, requestedWorktreePath))
  if (!worktree) {
    throw new Error(`Refusing to delete unregistered worktree path: ${requestedWorktreePath}`)
  }
  if (worktree.isMainWorktree || isDangerousWorktreeRemovalPath(worktree.path, repoPath)) {
    throw new Error(`Refusing to delete protected worktree path: ${worktree.path}`)
  }
  assertWorktreeDoesNotContainRegisteredWorktree(worktree.path, worktrees)
  return worktree
}

export function assertWorktreeDoesNotContainRegisteredWorktree(
  worktreePath: string,
  worktrees: readonly GitWorktreeInfo[]
): void {
  const nestedWorktree = worktrees.find((item) => {
    if (areWorktreePathsEqual(item.path, worktreePath)) {
      return false
    }
    return containsPath(worktreePath, item.path, getPathOps(worktreePath, item.path))
  })
  if (nestedWorktree) {
    // Why: `git worktree remove --force` treats nested worktrees as ordinary
    // untracked directories and deletes their working files while leaving Git
    // with a prunable child worktree record.
    throw new Error(
      `Refusing to delete worktree because it contains another registered worktree: ${nestedWorktree.path}`
    )
  }
}

export async function canSafelyRemoveOrphanedWorktreeDirectory(
  worktreePath: string,
  repoPath: string
): Promise<boolean> {
  if (isDangerousWorktreeRemovalPath(worktreePath, repoPath)) {
    return false
  }

  try {
    const gitEntry = await lstat(getPathOps(worktreePath).join(worktreePath, '.git'))
    return gitEntry.isFile() || gitEntry.isDirectory() || gitEntry.isSymbolicLink()
  } catch {
    return false
  }
}
