import * as path from 'node:path'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import { isBranchCheckedOutInWorktreeError } from '../shared/git-branch-delete-refusal'
import { BranchDeletionUnverifiedError } from '../shared/git-branch-delete-verification'
import { assertWorktreeUnlockedForRemoval } from '../shared/worktree/removal'
import { isSubmoduleWorktreeRemovalRefusal } from '../shared/worktree/submodule-removal'
import { deleteMergedRelayBranchAfterWorktreeRemoval } from './git-handler-branch-cleanup'
import type { GitExec } from './git-handler-ops'
import type { GitCapabilityCache } from '../shared/git-capability-cache'
import { readRelayWorktreeList } from './git-handler-worktree-list'

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

async function listRelayWorktreesForRemoval(
  git: GitExec,
  repoPath: string,
  capabilities: GitCapabilityCache
) {
  try {
    return await readRelayWorktreeList(git, repoPath, capabilities)
  } catch {
    return []
  }
}

async function forceDeleteRelayBranchAfterRollback(
  git: GitExec,
  repoPath: string,
  branchName: string
): Promise<void> {
  try {
    await git(['branch', '-D', '--', branchName], repoPath)
    return
  } catch (error) {
    if (!isBranchCheckedOutInWorktreeError(error)) {
      throw error
    }
  }

  try {
    // Prune only when a stale checkout registration may block rollback.
    await git(['worktree', 'prune'], repoPath)
  } catch (error) {
    console.warn(
      `relay removeWorktree: failed to prune worktrees before deleting branch "${branchName}"`,
      error
    )
    return
  }

  try {
    await git(['branch', '-D', '--', branchName], repoPath)
  } catch (error) {
    if (isBranchCheckedOutInWorktreeError(error)) {
      return
    }
    throw error
  }
}

export async function removeWorktreeOp(
  git: GitExec,
  params: Record<string, unknown>,
  capabilities: GitCapabilityCache
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

  const worktreesBeforeRemoval = await listRelayWorktreesForRemoval(git, repoPath, capabilities)
  const removedWorktree = worktreesBeforeRemoval.find((worktree) =>
    areRelayWorktreePathsEqual(worktree.path, worktreePath)
  )
  const branchName = normalizeLocalBranchRef(removedWorktree?.branch ?? '')
  const branchHead = removedWorktree?.head ?? ''

  assertWorktreeUnlockedForRemoval(removedWorktree)

  const args = ['worktree', 'remove']
  if (force) {
    args.push('--force')
  }
  args.push(worktreePath)
  try {
    await git(args, repoPath)
  } catch (error) {
    if (force || !isSubmoduleWorktreeRemovalRefusal(error)) {
      throw error
    }
    // Why: Git refuses non-force removal of any worktree with an initialised
    // submodule even when everything is clean. Re-prove cleanliness (parent
    // status reports dirty submodule content as ` M <sub>`), then --force.
    const { stdout } = await git(['status', '--porcelain', '--untracked-files=all'], worktreePath)
    if (stdout.trim()) {
      const dirtyError = new Error('Worktree has uncommitted or untracked changes.')
      ;(dirtyError as Error & { stdout?: string }).stdout = stdout
      throw dirtyError
    }
    await git(['worktree', 'remove', '--force', worktreePath], repoPath)
  }

  if (!branchName) {
    return {}
  }
  if (!deleteBranch) {
    return {}
  }

  try {
    if (forceBranchDelete) {
      await forceDeleteRelayBranchAfterRollback(git, repoPath, branchName)
      return {}
    }
    if (
      branchHead &&
      (await deleteMergedRelayBranchAfterWorktreeRemoval(
        git,
        repoPath,
        branchName,
        branchHead,
        capabilities
      ))
    ) {
      return {}
    }
  } catch (error) {
    // Removal already succeeded; a failed or raced proof must preserve the branch.
    if (error instanceof BranchDeletionUnverifiedError) {
      throw error
    }
    console.warn(
      `relay removeWorktree: preserved local branch "${branchName}" after removing worktree`,
      error
    )
  }
  return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
}
