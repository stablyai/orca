import * as path from 'node:path'
import type { RemoveWorktreeResult } from '../shared/types'
import { assertWorktreeUnlockedForRemoval } from '../shared/worktree-removal'
import { isSubmoduleWorktreeRemovalRefusal } from '../shared/worktree-submodule-removal'
import { deleteAlreadyMergedRelayBranchAfterSafeDeleteFailure } from './git-handler-branch-cleanup'
import type { GitExec } from './git-handler-ops'
import type { GitCapabilityCache } from '../shared/git-capability-cache'
import { readRelayWorktreeList } from './git-handler-worktree-list'

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

function isWorktreeRemovalInterruption(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }
  const details = error as {
    name?: unknown
    code?: unknown
    killed?: unknown
    signal?: unknown
  }
  return (
    details.name === 'AbortError' ||
    details.code === 'ABORT_ERR' ||
    details.code === 'ETIMEDOUT' ||
    details.killed === true ||
    (typeof details.signal === 'string' && details.signal.length > 0) ||
    ('message' in error &&
      typeof error.message === 'string' &&
      /\btimed out\b/i.test(error.message))
  )
}

function createWorktreeRemovalAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }
  const error = new Error('Worktree removal aborted.')
  error.name = 'AbortError'
  return error
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
  params: Record<string, unknown>,
  capabilities: GitCapabilityCache,
  options: { signal?: AbortSignal } = {}
): Promise<RemoveWorktreeResult> {
  const worktreePath = params.worktreePath as string
  const force = params.force as boolean | undefined
  const deleteBranch = params.deleteBranch !== false
  const forceBranchDelete = params.forceBranchDelete === true
  const timeoutValue = params.timeoutMs
  if (
    timeoutValue !== undefined &&
    (typeof timeoutValue !== 'number' || !Number.isFinite(timeoutValue) || timeoutValue <= 0)
  ) {
    throw new Error('Invalid worktree removal timeout.')
  }
  const deadlineAt = timeoutValue === undefined ? undefined : Date.now() + timeoutValue
  let interruptionError: unknown
  const stageGit: GitExec = async (args, cwd, childOptions) => {
    const remaining = deadlineAt === undefined ? undefined : deadlineAt - Date.now()
    if (remaining !== undefined && remaining <= 0) {
      interruptionError = new Error('Worktree removal timed out.')
      throw interruptionError
    }
    const signal = childOptions?.signal ?? options.signal
    try {
      return await (remaining === undefined && !signal && childOptions === undefined
        ? git(args, cwd)
        : git(args, cwd, {
            ...childOptions,
            ...(signal ? { signal } : {}),
            ...(remaining === undefined ? {} : { timeout: remaining })
          }))
    } catch (error) {
      if (isWorktreeRemovalInterruption(error)) {
        interruptionError = error
      }
      throw error
    }
  }
  const throwIfInterrupted = (error?: unknown): void => {
    if (isWorktreeRemovalInterruption(error)) {
      throw error
    }
    if (interruptionError !== undefined) {
      throw interruptionError
    }
    if (options.signal?.aborted) {
      throw createWorktreeRemovalAbortError(options.signal)
    }
  }

  let repoPath = worktreePath
  try {
    const { stdout } = await stageGit(['rev-parse', '--git-common-dir'], worktreePath)
    const commonDir = stdout.trim()
    if (commonDir && commonDir !== '.git') {
      repoPath = resolveRelayRepoPath(worktreePath, commonDir)
    }
  } catch (error) {
    throwIfInterrupted(error)
    // fall through with worktreePath as repo
  }

  const worktreesBeforeRemoval = await listRelayWorktreesForRemoval(
    stageGit,
    repoPath,
    capabilities
  )
  throwIfInterrupted()
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
    await stageGit(args, repoPath)
  } catch (error) {
    if (force || !isSubmoduleWorktreeRemovalRefusal(error)) {
      throw error
    }
    // Why: Git refuses non-force removal of any worktree with an initialised
    // submodule even when everything is clean. Re-prove cleanliness (parent
    // status reports dirty submodule content as ` M <sub>`), then --force.
    const { stdout } = await stageGit(
      ['status', '--porcelain', '--untracked-files=all'],
      worktreePath
    )
    if (stdout.trim()) {
      const dirtyError = new Error('Worktree has uncommitted or untracked changes.')
      ;(dirtyError as Error & { stdout?: string }).stdout = stdout
      throw dirtyError
    }
    await stageGit(['worktree', 'remove', '--force', worktreePath], repoPath)
  }

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
      stageGit,
      repoPath,
      branchName,
      forceBranchDelete
    )
    throwIfInterrupted()
    if (branchDeleteResult === 'checked-out') {
      return {}
    }
    return {}
  } catch (error) {
    throwIfInterrupted(error)
    if (!forceBranchDelete && branchHead) {
      try {
        if (
          await deleteAlreadyMergedRelayBranchAfterSafeDeleteFailure(
            stageGit,
            repoPath,
            branchName,
            branchHead,
            capabilities
          )
        ) {
          throwIfInterrupted()
          return {}
        }
      } catch (alreadyMergedDeleteError) {
        throwIfInterrupted(alreadyMergedDeleteError)
        // Why: worktree is gone; preserve branch recovery on cleanup races.
        console.warn(
          `relay removeWorktree: failed to delete already-merged local branch "${branchName}" after removing worktree`,
          alreadyMergedDeleteError
        )
      }
    }
    throwIfInterrupted()
    // Expected when the branch still has unmerged/unpublished commits: keep it.
    console.warn(
      `relay removeWorktree: preserved local branch "${branchName}" after removing worktree (not fully merged)`,
      error
    )
    return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
  }
}
