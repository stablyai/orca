import * as path from 'node:path'
import type { RemoveWorktreeResult } from '../shared/worktree/create-types'
import { isBranchCheckedOutInWorktreeError } from '../shared/git-branch-delete-refusal'
import { assertWorktreeUnlockedForRemoval } from '../shared/worktree/removal'
import { isSubmoduleWorktreeRemovalRefusal } from '../shared/worktree/submodule-removal'
import { isBranchHeadInBaseHistory } from '../shared/git-branch-base-containment'
import { forceDeletePreservedRelayBranch } from './git-handler-branch-cleanup'
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
    if (
      !forceBranchDelete &&
      branchHead &&
      (await deleteRelayBranchInBaseHistory(git, repoPath, branchName, branchHead))
    ) {
      return {}
    }
    // Expected when the branch still has unmerged/unpublished commits: keep it.
    console.warn(
      `relay removeWorktree: preserved local branch "${branchName}" after removing worktree (not fully merged)`,
      error
    )
    return { preservedBranch: { branchName, ...(branchHead ? { head: branchHead } : {}) } }
  }
}

/** `branch -d` refused, but the head is in its base's history: delete it, still guarded on head. */
async function deleteRelayBranchInBaseHistory(
  git: GitExec,
  repoPath: string,
  branchName: string,
  branchHead: string
): Promise<boolean> {
  try {
    if (!(await isBranchHeadInBaseHistory((args) => git(args, repoPath), branchName, branchHead))) {
      return false
    }
    await forceDeletePreservedRelayBranch(git, repoPath, branchName, branchHead)
    return true
  } catch (error) {
    // Why: the checkout is already gone; a raced delete degrades to the kept-branch path.
    console.warn(
      `relay removeWorktree: kept branch "${branchName}": deleting it at its base failed`,
      error
    )
    return false
  }
}
