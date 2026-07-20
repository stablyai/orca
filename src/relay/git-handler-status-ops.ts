/**
 * Status and conflict-detection operations extracted from git-handler.ts.
 * Why: split to satisfy oxlint max-lines (300); pure data ops on git state, no class coupling.
 */
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseUnmergedEntry } from './git-handler-utils'
import { parseStatusOutput } from './git-status-output-parser'
import type { GitExec } from './git-handler-ops'
import type { GitUpstreamStatus } from '../shared/types'
import { splitRemoteBranchName } from '../shared/git-effective-upstream'
import { readOrProbeNoEffectiveUpstreamStatus } from './git-status-upstream-negative-cache'
import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from '../shared/git-uncommitted-line-stats'
import { DEFAULT_GIT_STATUS_LIMIT } from '../shared/git-status-limit'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCacheKey,
  reuseOrRecomputeGitStatusLineStats
} from '../shared/git-status-line-stats-cache'

export async function resolveGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')
  try {
    const contents = await readFile(dotGitPath, 'utf-8')
    const match = contents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      return path.resolve(worktreePath, match[1])
    }
  } catch {
    // .git is a directory, not a file
  }
  return dotGitPath
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
  params: Record<string, unknown>,
  options: { signal?: AbortSignal } = {}
): Promise<{
  entries: Record<string, unknown>[]
  conflictOperation: string
  head?: string
  branch?: string
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
  const rawLimit = params.limit
  const limit =
    typeof rawLimit === 'number' && Number.isFinite(rawLimit) && rawLimit >= 0
      ? Math.floor(rawLimit)
      : DEFAULT_GIT_STATUS_LIMIT
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
    const { stdout } = await git(statusArgs, worktreePath, {
      // Why: status polling is read-like; avoid racing terminal Git on .git/worktrees/*/index.lock.
      disableOptionalLocks: true,
      signal: options.signal
    })
    const parsed = parseStatusOutput(stdout)
    head = parsed.head
    branch = parsed.branch
    upstreamStatus = parsed.upstreamStatus
    ignoredPaths = parsed.ignoredPaths
    statusLength = parsed.entries.length
    // Why: cap entry count so an enormous un-ignored folder can't push tens of thousands of rows through every poll.
    if (limit !== 0 && parsed.entries.length > limit) {
      didHitLimit = true
      for (let i = 0; i < limit; i++) {
        entries.push(parsed.entries[i])
      }
    } else {
      for (const entry of parsed.entries) {
        entries.push(entry)
      }
    }

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

      for (const uLine of parsed.unmergedLines) {
        const entry = parseUnmergedEntry(worktreePath, uLine)
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

  return {
    entries,
    conflictOperation,
    head,
    branch,
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
