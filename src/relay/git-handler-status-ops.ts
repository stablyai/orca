/**
 * Status and conflict-detection operations extracted from git-handler.ts.
 * Why: split to satisfy oxlint max-lines (300); pure data ops on git state, no class coupling.
 */
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { parseUnmergedEntry } from './git-handler-utils'
import type { GitExec } from './git-handler-ops'
import type { RelayGitStreamExec } from './git-stdout-stream'
import type { GitUpstreamStatus } from '../shared/types'
import { StatusPorcelainParser } from '../shared/git-status-porcelain-parser'
import {
  readWorktreeRebaseState,
  reprobeDetachedHeadRebaseState,
  type WorktreeRebaseState
} from '../shared/git-rebase-worktree-state'
import { resolveWorktreeGitDir } from '../shared/git-worktree-dir'
import { splitRemoteBranchName } from '../shared/git-effective-upstream'
import { readOrProbeNoEffectiveUpstreamStatus } from './git-status-upstream-negative-cache'
import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from '../shared/git-uncommitted-line-stats'
import { resolveGitStatusLimit } from '../shared/git-status-limit'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCacheKey,
  reuseOrRecomputeGitStatusLineStats
} from '../shared/git-status-line-stats-cache'

// Why: delegate to the shared resolver so relay and main state probes cannot drift.
export async function resolveGitDir(worktreePath: string): Promise<string> {
  return resolveWorktreeGitDir(worktreePath)
}

export async function detectConflictOperation(worktreePath: string): Promise<string> {
  const gitDir = await resolveGitDir(worktreePath)
  try {
    if (existsSync(path.join(gitDir, 'MERGE_HEAD'))) {
      return 'merge'
    }
    if (
      existsSync(path.join(gitDir, 'rebase-merge')) ||
      existsSync(path.join(gitDir, 'rebase-apply'))
    ) {
      return 'rebase'
    }
    if (existsSync(path.join(gitDir, 'CHERRY_PICK_HEAD'))) {
      return 'cherry-pick'
    }
  } catch {
    // fs error — treat as no conflict operation
  }
  return 'unknown'
}

export async function getStatusOp(
  git: GitExec,
  streamGit: RelayGitStreamExec,
  params: Record<string, unknown>,
  options: { signal?: AbortSignal } = {}
): Promise<{
  entries: Record<string, unknown>[]
  conflictOperation: string
  head?: string
  branch?: string
  rebasing?: boolean
  rebaseBranch?: string
  upstreamStatus?: GitUpstreamStatus
  ignoredPaths?: string[]
  didHitLimit?: boolean
  statusLength?: number
}> {
  const worktreePath = params.worktreePath as string
  const lineStatsCacheKey = `relay\0${worktreePath}`
  const lineStatsWriteToken = beginGitStatusLineStatsCacheWrite(lineStatsCacheKey)
  const includeIgnored = params.includeIgnored === true
  // Why: reject NaN/negative limits — NaN would silently disable capping, negatives would over-truncate.
  const limit = resolveGitStatusLimit(params.limit)
  // Why: probe rebase state BEFORE `git status` reads HEAD so a `rebase --abort` torn read
  // errs toward {reattached branch, rebasing} (harmless). The mirror-image race at rebase
  // *start* is covered by the post-status re-probe below.
  const rebaseStatePromise: Promise<WorktreeRebaseState> = readWorktreeRebaseState(
    worktreePath
  ).catch(() => ({ rebasing: false, rebaseBranch: null }))
  const conflictOperation = await detectConflictOperation(worktreePath)
  const entries: Record<string, unknown>[] = []
  let head: string | undefined
  let branch: string | undefined
  let upstreamStatus: GitUpstreamStatus | undefined
  let ignoredPaths: string[] = []
  let didHitLimit = false
  let statusLength = 0

  try {
    // Why: core.quotePath=false keeps non-ASCII filenames as raw UTF-8 instead of octal escapes that render as gibberish.
    const statusArgs = [
      '-c',
      'core.quotePath=false',
      'status',
      '--porcelain=v2',
      '--branch',
      '--untracked-files=all'
    ]
    if (includeIgnored) {
      statusArgs.push('--ignored=matching')
    }
    const parser = new StatusPorcelainParser()
    const { stoppedEarly } = await streamGit(statusArgs, worktreePath, {
      // Why: status polling is read-like; avoid racing terminal Git on .git/worktrees/*/index.lock.
      disableOptionalLocks: true,
      signal: options.signal,
      onStdout: (chunk) => parser.update(chunk, limit)
    })
    if (!stoppedEarly) {
      parser.finish()
    }
    head = parser.branch.head
    branch = parser.branch.branch
    ignoredPaths = parser.ignoredPaths
    statusLength = parser.statusLength
    didHitLimit = stoppedEarly
    const { upstreamName, upstreamAheadBehind } = parser.branch
    upstreamStatus = upstreamName
      ? {
          hasUpstream: true,
          upstreamName,
          ahead: upstreamAheadBehind?.ahead ?? 0,
          behind: upstreamAheadBehind?.behind ?? 0
        }
      : { hasUpstream: false, ahead: 0, behind: 0 }

    if (!didHitLimit) {
      if (shouldProbeEffectiveUpstreamStatus(branch, upstreamStatus?.upstreamName)) {
        const branchName = getShortBranchName(branch)
        if (branchName) {
          try {
            // Why: this probe coalesces across concurrent status reads, so one request's abort must not reject the shared in-flight promise.
            upstreamStatus = await readOrProbeNoEffectiveUpstreamStatus(
              { worktreePath, branchName, upstreamName: upstreamStatus?.upstreamName },
              (args) => git(args, worktreePath),
              {
                bypassCache: params.bypassEffectiveUpstreamNegativeCache === true
              }
            )
          } catch {
            // Why: keep returning working-tree entries even if the upstream probe hits a transient SSH/git ref error.
          }
        }
      }
    }

    // Why: resolve deferred conflicts in Git's output order so the cap cannot hide
    // an early conflict behind ordinary rows that appeared later in the stream.
    for (const record of parser.statusRecords) {
      if (didHitLimit && entries.length >= limit) {
        break
      }
      if (record.type === 'entry') {
        entries.push(record.entry as Record<string, unknown>)
      } else {
        const entry = parseUnmergedEntry(worktreePath, record.line)
        if (entry) {
          entries.push(entry)
        }
      }
    }
  } catch (error) {
    // Why: an aborted scan must reject, not resolve as a completed (empty) status result.
    if (options.signal?.aborted) {
      throw error
    }
    // not a git repo or git not available
  }

  // Why: skip line-stats when the limit was hit — numstat over a huge change set would reintroduce the cost the limit avoids.
  if (!didHitLimit) {
    await reuseOrRecomputeGitStatusLineStats({
      cacheKey: lineStatsCacheKey,
      head,
      entries,
      writeToken: lineStatsWriteToken,
      reuse: params.reuseLineStats === true,
      isAborted: () => options.signal?.aborted === true,
      recompute: () => attachLineStats(git, worktreePath, entries, options.signal)
    })
  } else {
    clearGitStatusLineStatsCacheKey(lineStatsCacheKey, lineStatsWriteToken)
  }

  // Why: a late abort (during unmerged/upstream/line-stats work) must still reject, not resolve as completed.
  if (options.signal?.aborted) {
    const error = new Error('The operation was aborted.')
    error.name = 'AbortError'
    throw error
  }

  let rebaseState = await rebaseStatePromise
  if (head && !branch) {
    // Why: a rebase starting between the early probe and status reading HEAD would
    // otherwise report {detached, not rebasing} — misread downstream as a branch switch.
    rebaseState = await reprobeDetachedHeadRebaseState(rebaseState, () =>
      readWorktreeRebaseState(worktreePath)
    )
  }

  return {
    entries,
    conflictOperation,
    head,
    branch,
    ...(rebaseState.rebasing
      ? {
          rebasing: true,
          ...(rebaseState.rebaseBranch ? { rebaseBranch: rebaseState.rebaseBranch } : {})
        }
      : {}),
    upstreamStatus,
    ...(includeIgnored ? { ignoredPaths } : {}),
    ...(didHitLimit ? { didHitLimit: true, statusLength } : {})
  }
}

async function runNumstat(
  git: GitExec,
  worktreePath: string,
  cached: boolean,
  signal?: AbortSignal
): Promise<Map<string, GitLineStats> | null> {
  try {
    const { stdout } = await git(
      ['-c', 'core.quotePath=false', 'diff', ...(cached ? ['--cached'] : []), '--numstat', '-M'],
      worktreePath,
      { disableOptionalLocks: true, signal }
    )
    return parseNumstat(stdout)
  } catch (error) {
    // Why: an aborted pass must reject so a cancelled scan is never treated as completed.
    if (signal?.aborted) {
      throw error
    }
    // Why: null (vs an empty map) tells the caller the pass is incomplete and must not be cached.
    return null
  }
}

/** Returns false when a numstat pass failed, so callers skip caching it. */
async function attachLineStats(
  git: GitExec,
  worktreePath: string,
  entries: Record<string, unknown>[],
  signal?: AbortSignal
): Promise<boolean> {
  if (entries.length === 0) {
    return true
  }
  const hasStaged = entries.some((entry) => entry.area === 'staged')
  const hasUnstaged = entries.some((entry) => entry.area === 'unstaged')
  const untrackedPaths = entries
    .filter((entry) => entry.area === 'untracked')
    .map((entry) => entry.path as string)
  const emptyStats = new Map<string, GitLineStats>()
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged ? runNumstat(git, worktreePath, true, signal) : Promise.resolve(emptyStats),
    hasUnstaged ? runNumstat(git, worktreePath, false, signal) : Promise.resolve(emptyStats),
    collectUntrackedAdditions(worktreePath, untrackedPaths, signal)
  ])
  for (const entry of entries) {
    const filePath = entry.path as string
    applyLineStats(
      entry as { added?: number; removed?: number },
      entry.area === 'staged'
        ? (stagedStats ?? emptyStats).get(filePath)
        : entry.area === 'unstaged'
          ? (unstagedStats ?? emptyStats).get(filePath)
          : untrackedStats.get(filePath)
    )
  }
  return stagedStats !== null && unstagedStats !== null
}

function getShortBranchName(branch: string | undefined): string | null {
  const prefix = 'refs/heads/'
  return branch?.startsWith(prefix) ? branch.slice(prefix.length) : null
}

function shouldProbeEffectiveUpstreamStatus(
  branch: string | undefined,
  upstreamName: string | undefined
): boolean {
  const branchName = getShortBranchName(branch)
  if (!branchName) {
    return false
  }
  if (!upstreamName) {
    return true
  }
  const parsed = splitRemoteBranchName(upstreamName)
  return parsed?.remoteName === 'origin' && parsed.branchName !== branchName
}
