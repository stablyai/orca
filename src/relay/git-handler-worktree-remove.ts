import * as path from 'node:path'
import type { RemoveWorktreeResult } from '../shared/types'
import { deleteAlreadyMergedRelayBranchAfterSafeDeleteFailure } from './git-handler-branch-cleanup'
import type { GitExec } from './git-handler-ops'
import { isUnsupportedWorktreeListZError, parseWorktreeList } from './git-handler-utils'

type RelayWorktreeInfo = {
  path: string
  branch?: string
  head?: string
}

function getErrorText(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const parts: string[] = []
    if ('message' in error && typeof error.message === 'string') {
      parts.push(error.message)
    }
    if ('stderr' in error && typeof error.stderr === 'string') {
      parts.push(error.stderr)
    }
    if ('stdout' in error && typeof error.stdout === 'string') {
      parts.push(error.stdout)
    }
    return parts.join('\n')
  }
  return String(error)
}

function isBranchCheckedOutInWorktreeError(error: unknown): boolean {
  return /cannot delete branch .*(?:used by worktree|checked out)|branch .*is checked out/i.test(
    getErrorText(error)
  )
}

function normalizeLocalBranchRef(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

function isPosixAbsolutePath(value: string): boolean {
  return value.startsWith('/')
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function resolveRelayRepoPath(worktreePath: string, commonDir: string): string {
  if (isPosixAbsolutePath(worktreePath) || isPosixAbsolutePath(commonDir)) {
    // Why: tests can run on Windows while the relay operates on SSH/POSIX
    // paths; the default path API would reinterpret "/repo" as "G:\repo".
    return path.posix.resolve(worktreePath, commonDir, '..')
  }
  if (isWindowsAbsolutePath(worktreePath) || isWindowsAbsolutePath(commonDir)) {
    return path.win32.resolve(worktreePath, commonDir, '..')
  }
  return path.resolve(worktreePath, commonDir, '..')
}

function normalizeRelayWorktreePathForCompare(value: string): string {
  if (isPosixAbsolutePath(value)) {
    return path.posix.normalize(path.posix.resolve(value))
  }
  if (isWindowsAbsolutePath(value)) {
    return path.win32.normalize(path.win32.resolve(value))
  }
  return path.normalize(path.resolve(value))
}

function areRelayWorktreePathsEqual(leftPath: string, rightPath: string): boolean {
  const left = normalizeRelayWorktreePathForCompare(leftPath)
  const right = normalizeRelayWorktreePathForCompare(rightPath)
  const compareCaseInsensitive = isWindowsAbsolutePath(leftPath) && isWindowsAbsolutePath(rightPath)
  return compareCaseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

function normalizeRelayWorktrees(worktrees: Record<string, unknown>[]): RelayWorktreeInfo[] {
  return worktrees
    .map((worktree) => ({
      path: typeof worktree.path === 'string' ? worktree.path : '',
      head: typeof worktree.head === 'string' ? worktree.head : undefined,
      branch: typeof worktree.branch === 'string' ? worktree.branch : undefined
    }))
    .filter((worktree) => worktree.path.length > 0)
}

async function readRelayWorktreeList(git: GitExec, repoPath: string): Promise<RelayWorktreeInfo[]> {
  try {
    const { stdout } = await git(['worktree', 'list', '--porcelain', '-z'], repoPath)
    return normalizeRelayWorktrees(parseWorktreeList(stdout, { nulDelimited: true }))
  } catch (error) {
    if (!isUnsupportedWorktreeListZError(error)) {
      throw error
    }
  }

  // Why: `-z` preserves newlines; fallback keeps Git <2.36 compatible.
  const { stdout } = await git(['worktree', 'list', '--porcelain'], repoPath)
  return normalizeRelayWorktrees(parseWorktreeList(stdout))
}

async function listRelayWorktreesForRemoval(git: GitExec, repoPath: string) {
  try {
    return await readRelayWorktreeList(git, repoPath)
  } catch {
    return []
  }
}

async function deleteRelayBranchAfterWorktreeRemoval(
  git: GitExec,
  repoPath: string,
  branchName: string,
  forceBranchDelete: boolean
): Promise<'deleted' | 'checked-out'> {
  const deleteFlag = forceBranchDelete ? '-D' : '-d'
  try {
    await git(['branch', deleteFlag, '--', branchName], repoPath)
    return 'deleted'
  } catch (error) {
    if (!isBranchCheckedOutInWorktreeError(error)) {
      throw error
    }
  }

  try {
    // Why: branch deletion is the cheap live-checkout guard. Only prune when
    // Git reports a checked-out branch, which may be stale worktree metadata.
    await git(['worktree', 'prune'], repoPath)
  } catch (error) {
    console.warn(
      `relay removeWorktree: failed to prune worktrees before deleting branch "${branchName}"`,
      error
    )
    return 'checked-out'
  }

  try {
    await git(['branch', deleteFlag, '--', branchName], repoPath)
    return 'deleted'
  } catch (error) {
    if (isBranchCheckedOutInWorktreeError(error)) {
      return 'checked-out'
    }
    throw error
  }
}

export async function removeWorktreeOp(
  git: GitExec,
  params: Record<string, unknown>
): Promise<RemoveWorktreeResult> {
  const worktreePath = params.worktreePath as string
  const force = params.force as boolean | undefined
  const deleteBranch = params.deleteBranch !== false
  const forceBranchDelete = params.forceBranchDelete === true

  let repoPath = worktreePath
  try {
    const { stdout } = await git(['rev-parse', '--git-common-dir'], worktreePath)
    const commonDir = stdout.trim()
    if (commonDir && commonDir !== '.git') {
      repoPath = resolveRelayRepoPath(worktreePath, commonDir)
    }
  } catch {
    // fall through with worktreePath as repo
  }

  const worktreesBeforeRemoval = await listRelayWorktreesForRemoval(git, repoPath)
  const removedWorktree = worktreesBeforeRemoval.find((worktree) =>
    areRelayWorktreePathsEqual(worktree.path, worktreePath)
  )
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')
  const branchHead = removedWorktree?.head ?? ''

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  await git(args, repoPath)

  if (!branchName) {
    return {}
  }
  if (!deleteBranch) {
    return {}
  }

  // Why: SSH worktree deletion should mirror local deletion. Dropping the
  // branch also removes its upstream config, which lets fork-remotes cleanup
  // after the last PR review worktree is gone.
  try {
    // Why: use `-d` (not `-D`) to mirror the local removeWorktree fix.
    const branchDeleteResult = await deleteRelayBranchAfterWorktreeRemoval(
      git,
      repoPath,
      branchName,
      forceBranchDelete
    )
    if (branchDeleteResult === 'checked-out') {
      return {}
    }
    return {}
  } catch (error) {
    if (!forceBranchDelete && branchHead) {
      try {
        if (
          await deleteAlreadyMergedRelayBranchAfterSafeDeleteFailure(
            git,
            repoPath,
            branchName,
            branchHead
          )
        ) {
          return {}
        }
      } catch (alreadyMergedDeleteError) {
        // Why: worktree is gone; preserve branch recovery on cleanup races.
        console.warn(
          `relay removeWorktree: failed to delete already-merged local branch "${branchName}" after removing worktree`,
          alreadyMergedDeleteError
        )
      }
    }
    // Expected when the branch still has unmerged/unpublished commits: keep it.
    console.warn(
      `relay removeWorktree: preserved local branch "${branchName}" after removing worktree (not fully merged)`,
      error
    )
    return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
  }
}
