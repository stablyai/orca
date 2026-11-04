import { access, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitConflictOperation,
  GitRebaseOperationState
} from '../../../shared/git/status/git-status-types'
import {
  isMissingGitAdminEntry,
  readGitAdminFile
} from '../../../shared/git/metadata/git-common-directory'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { runWithGitReadCacheInvalidation } from './git-read-cache-invalidation'
import { resolveGitDir, resolveVerifiedGitDir } from './resolve-git-dir'

// HEAD detection races may yield unknown for one poll; rebase directories persist more reliably than REBASE_HEAD.
export async function detectConflictOperation(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<GitConflictOperation> {
  const gitDir = await resolveGitDir(worktreePath, options)
  const mergeHead = path.join(gitDir, 'MERGE_HEAD')
  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD')
  const revertHead = path.join(gitDir, 'REVERT_HEAD')
  const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
  const rebaseApplyDir = path.join(gitDir, 'rebase-apply')

  // Probe concurrently without blocking main: each WSL/UNC path can cost a 9p round trip.
  const [hasMergeHead, hasCherryPickHead, hasRebaseMergeDir, hasRebaseApplyDir, hasRevertHead] =
    await Promise.all(
      [mergeHead, cherryPickHead, rebaseMergeDir, rebaseApplyDir, revertHead].map(pathExists)
    )
  const hasRebaseDir = hasRebaseMergeDir || hasRebaseApplyDir

  if (hasMergeHead) {
    return 'merge'
  }
  if (hasRebaseDir) {
    return 'rebase'
  }
  if (hasCherryPickHead) {
    return 'cherry-pick'
  }
  if (hasRevertHead) {
    return 'revert'
  }
  return 'unknown'
}

export type RebaseOperationRead =
  | { state: Extract<GitRebaseOperationState, 'active'>; branch?: string }
  /** `headDetached` is read after the probes: rebase reattaches HEAD before removing its state. */
  | { state: Extract<GitRebaseOperationState, 'none'>; headDetached: boolean }
  | { state: Extract<GitRebaseOperationState, 'unverifiable'> }

const UNVERIFIABLE: RebaseOperationRead = { state: 'unverifiable' }

type PathProbe = 'present' | 'absent' | 'error'

async function probePath(target: string): Promise<PathProbe> {
  try {
    await stat(target)
    return 'present'
  } catch (error) {
    return isMissingGitAdminEntry(error) ? 'absent' : 'error'
  }
}

async function activeRebase(stateDir: string): Promise<RebaseOperationRead> {
  // A detached-HEAD rebase records 'detached HEAD'; unreadable names still leave the rebase active.
  const headName = await readGitAdminFile(path.join(stateDir, 'head-name')).catch(() => null)
  const ref = headName?.trim() ?? ''
  return ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length
    ? { state: 'active', branch: ref }
    : { state: 'active' }
}

/** Fail-closed rebase verdict for one checkout, read spawn-free on its owning host; git am is not a rebase. */
export async function readRebaseOperation(
  worktreePath: string,
  options: Pick<GitRuntimeOptions, 'wslDistro'> = {}
): Promise<RebaseOperationRead> {
  const gitDir = await resolveVerifiedGitDir(worktreePath, options)
  if (!gitDir) {
    return UNVERIFIABLE
  }
  const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
  const rebaseApplyDir = path.join(gitDir, 'rebase-apply')
  const [rebaseMerge, rebaseApply] = await Promise.all([
    probePath(rebaseMergeDir),
    probePath(rebaseApplyDir)
  ])
  if (rebaseMerge === 'present') {
    return activeRebase(rebaseMergeDir)
  }
  if (rebaseApply === 'present') {
    // Git's wt-status rule: rebase-apply without `applying` is a rebase, with it git am.
    const applying = await probePath(path.join(rebaseApplyDir, 'applying'))
    if (applying === 'error') {
      return UNVERIFIABLE
    }
    if (applying === 'absent') {
      return activeRebase(rebaseApplyDir)
    }
  }
  if (rebaseMerge === 'error' || rebaseApply === 'error') {
    return UNVERIFIABLE
  }
  let head: string
  try {
    head = await readFile(path.join(gitDir, 'HEAD'), 'utf-8')
  } catch {
    return UNVERIFIABLE
  }
  return { state: 'none', headDetached: !head.trimStart().startsWith('ref:') }
}

/** Treat inaccessible paths as absent without throwing. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

export async function abortMerge(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['merge', '--abort'], gitOptionsForWorktree(worktreePath, options))
  )
}

export async function abortRebase(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await runWithGitReadCacheInvalidation(() =>
    gitExecFileAsync(['rebase', '--abort'], gitOptionsForWorktree(worktreePath, options))
  )
}
