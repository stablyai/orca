/**
 * Status and conflict-detection operations extracted from git-handler.ts.
 *
 * Why: oxlint max-lines (300) requires splitting large files.
 * These functions are pure data operations on git state — no class coupling.
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
  params: Record<string, unknown>
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
  const includeIgnored = params.includeIgnored === true
  // Why: reject non-finite/negative limits so the cap guard stays reliable
  // (NaN would silently disable capping; negatives would over-truncate).
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
    // Why: -c core.quotePath=false keeps non-ASCII filenames as raw UTF-8 in
    // git's stdout instead of C-style octal escapes; without it the parsed
    // entry.path renders as gibberish in the source-control sidebar and
    // downstream blob lookups miss.
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
      // Why: status polling is read-like; avoid refreshing the index and racing
      // terminal Git commands on `.git/worktrees/*/index.lock`.
      disableOptionalLocks: true
    })
    const parsed = parseStatusOutput(stdout)
    head = parsed.head
    branch = parsed.branch
    upstreamStatus = parsed.upstreamStatus
    ignoredPaths = parsed.ignoredPaths
    statusLength = parsed.entries.length
    // Why: cap the entry count to match the local path. A repo with an enormous
    // un-ignored folder would otherwise push tens of thousands of rows through
    // every poll; truncating keeps the SCM view (and its "too many changes"
    // state) consistent across local and SSH repos.
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
            upstreamStatus = await readOrProbeNoEffectiveUpstreamStatus(
              { worktreePath, branchName, upstreamName: upstreamStatus?.upstreamName },
              (args) => git(args, worktreePath),
              {
                bypassCache: params.bypassEffectiveUpstreamNegativeCache === true
              }
            )
          } catch {
            // Why: status polling should keep returning working-tree entries even
            // if the richer upstream probe hits a transient SSH/git ref error.
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
  } catch {
    // not a git repo or git not available
  }

  // Why: attach per-area line counts for the sidebar. Diffs run after status
  // (we need the entry list first) and only for areas that have entries, so a
  // clean tree costs zero extra git calls. Skipped when the limit was hit —
  // running numstat over a huge change set would reintroduce the cost the limit
  // exists to avoid.
  if (!didHitLimit) {
    await attachLineStats(git, worktreePath, entries)
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
  cached: boolean
): Promise<Map<string, GitLineStats>> {
  try {
    const { stdout } = await git(
      ['-c', 'core.quotePath=false', 'diff', ...(cached ? ['--cached'] : []), '--numstat', '-M'],
      worktreePath,
      { disableOptionalLocks: true }
    )
    return parseNumstat(stdout)
  } catch {
    // Why: a numstat failure should leave rows without counts rather than break
    // the whole status refresh.
    return new Map()
  }
}

async function attachLineStats(
  git: GitExec,
  worktreePath: string,
  entries: Record<string, unknown>[]
): Promise<void> {
  if (entries.length === 0) {
    return
  }
  const hasStaged = entries.some((entry) => entry.area === 'staged')
  const hasUnstaged = entries.some((entry) => entry.area === 'unstaged')
  const untrackedPaths = entries
    .filter((entry) => entry.area === 'untracked')
    .map((entry) => entry.path as string)
  const emptyStats = new Map<string, GitLineStats>()
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged ? runNumstat(git, worktreePath, true) : Promise.resolve(emptyStats),
    hasUnstaged ? runNumstat(git, worktreePath, false) : Promise.resolve(emptyStats),
    collectUntrackedAdditions(worktreePath, untrackedPaths)
  ])
  for (const entry of entries) {
    const filePath = entry.path as string
    applyLineStats(
      entry as { added?: number; removed?: number },
      entry.area === 'staged'
        ? stagedStats.get(filePath)
        : entry.area === 'unstaged'
          ? unstagedStats.get(filePath)
          : untrackedStats.get(filePath)
    )
  }
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
