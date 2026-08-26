import type {
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../shared/git-status-types'
import { StatusPorcelainParser } from '../../../shared/git-status-porcelain-parser'
import { resolveGitStatusLimit } from '../../../shared/git-status-limit'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import type { GitBranchLineTotal } from '../../../shared/git-branch-line-total'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCacheKey,
  reuseOrRecomputeGitStatusLineStats
} from '../../../shared/git-status-line-stats-cache'
import { gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import { findExistingWorktreeSymlinkPaths } from '../worktree-symlink-detection'
import type { GetStatusOptions } from './get-status-options'
import { statusReadLeaseOwner } from './git-read-cache-invalidation'
import { detectConflictOperation } from './git-conflict-operation'
import { parseUnmergedEntry } from './status-conflict-entries'
import { getEffectiveUpstreamStatusCacheKey } from './effective-upstream-status-cache'
import {
  getShortBranchName,
  readOrProbeEffectiveUpstreamStatus,
  shouldProbeEffectiveUpstreamStatus
} from './effective-upstream-status-probe'
import { attachLineStats } from './status-line-stats'
import {
  createBranchLineTotalInput,
  getStatusLineStatsCacheKey
} from './status-branch-line-total-input'

/**
 * Parse `git status --porcelain=v2` output into structured entries.
 */
export async function getStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  // Why nothing is cleared here: a status poll is a read. Dropping the in-flight diff entry
  // mid-read only made a concurrent identical request start duplicate git work, and the
  // settled diff cache is keyed on stamped git state, which a read cannot change anyway.
  // Mutations invalidate both, through invalidateGitReadCaches.
  const cacheKey = getStatusReadKey(worktreePath, options)
  return statusReadLeaseOwner.lease(cacheKey, options.signal, (sharedSignal) =>
    runGetStatus(worktreePath, { ...options, signal: sharedSignal })
  )
}

function getStatusReadKey(worktreePath: string, options: GetStatusOptions): string {
  // Why: each key part can change the output shape or runtime routing.
  const limit = resolveGitStatusLimit(options.limit)
  return stableInFlightKey([
    worktreePath,
    options.wslDistro ?? '',
    options.includeIgnored === true,
    options.reuseLineStats === true,
    // Why: the result carries a total only for callers who asked, and only for
    // this fork point, so a shared lease must never serve one to the other.
    options.branchLineTotalMergeBase ?? '',
    options.bypassEffectiveUpstreamNegativeCache === true,
    limit,
    // Why: this changes which entries survive, so it must not share a cache slot.
    options.sharedLinkPaths ?? []
  ])
}

/** Remove untracked entries that are shared symlinks Orca created.
 *
 *  Why this can't be left to Git: a directory-only ignore rule (`node_modules/`)
 *  matches the primary checkout's real directory but never the worktree's
 *  symlink, so Git reports it untracked forever — a phantom row in the diff and
 *  a permanently "dirty" worktree.
 *
 *  Tight on both axes: an entry must be configured as shared *and* actually be a
 *  symlink. A regular file the user created at a configured name still shows up,
 *  and so does a symlink at a path nobody declared shared. Mutates `entries`. */
async function dropSharedSymlinkUntrackedEntries(
  worktreePath: string,
  entries: GitStatusEntry[],
  sharedLinkPaths: readonly string[]
): Promise<void> {
  // Why: a clean tree has no untracked entries, so this costs nothing on the
  // common status-poll path — no syscall, no config read, no subprocess.
  if (sharedLinkPaths.length === 0 || !entries.some((entry) => entry.area === 'untracked')) {
    return
  }
  const sharedLinks = new Set(await findExistingWorktreeSymlinkPaths(worktreePath, sharedLinkPaths))
  if (sharedLinks.size === 0) {
    return
  }
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry.area === 'untracked' && sharedLinks.has(entry.path)) {
      entries.splice(index, 1)
    }
  }
}

async function runGetStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  const lineStatsCacheKey = getStatusLineStatsCacheKey(worktreePath, options)
  const lineStatsWriteToken = beginGitStatusLineStatsCacheWrite(lineStatsCacheKey)
  let effectiveUpstreamStatus: GitUpstreamStatus | undefined
  let statusSucceeded = false
  // Why: a bad limit (negative/fractional/NaN) breaks early-stop; require a valid non-negative int (0 disables the cap).
  const limit = resolveGitStatusLimit(options.limit)

  // Why: detectConflictOperation and git status are independent, so run them concurrently to save I/O latency.
  const conflictPromise = detectConflictOperation(worktreePath)
  // Why: core.quotePath=false keeps non-ASCII paths as raw UTF-8, not octal escapes, so entry.path is readable and lookups match.
  const statusArgs = [
    '-c',
    'core.quotePath=false',
    'status',
    '--porcelain=v2',
    '--branch',
    '--untracked-files=all'
  ]
  if (options.includeIgnored) {
    statusArgs.push('--ignored=matching')
  }

  // Why: stream + parse and stop at `limit` so a huge un-ignored folder can't buffer enough to crash the process.
  const parser = new StatusPorcelainParser()
  let didHitLimit = false
  // Why: attach rejection ownership before awaiting marker I/O, so a fast Git failure cannot become unhandled.
  const statusSettlementPromise = Promise.allSettled([
    (async () => {
      const result = await gitStreamStdout(statusArgs, {
        cwd: worktreePath,
        wslDistro: options.wslDistro,
        preferWslDirectGit: true,
        // Why: status polling is read-like; disable optional locks to avoid racing terminal Git on index.lock.
        env: gitOptionalLocksDisabledEnv(),
        signal: options.signal,
        onStdout: (chunk) => parser.update(chunk, limit)
      })
      if (!result.stoppedEarly) {
        parser.finish()
      }
      return result
    })()
  ])
  const conflictOperation = await conflictPromise

  try {
    const [statusResult] = await statusSettlementPromise
    if (statusResult.status === 'rejected') {
      throw statusResult.reason
    }
    didHitLimit = statusResult.value.stoppedEarly
    statusSucceeded = true
  } catch (error) {
    // Why: an aborted scan must reject, not resolve as an empty result.
    if (options.signal?.aborted) {
      throw error
    }
    // Not a git repo or git not available
  }

  const entries: GitStatusEntry[] = []
  const { head, branch, upstreamName, upstreamAheadBehind } = parser.branch

  // Why: resolve deferred conflicts in Git's output order so the cap cannot hide
  // an early conflict behind ordinary rows that appeared later in the stream.
  for (const record of parser.statusRecords) {
    if (didHitLimit && entries.length >= limit) {
      break
    }
    if (record.type === 'entry') {
      entries.push(record.entry)
    } else {
      const unmergedEntry = await parseUnmergedEntry(worktreePath, record.line)
      if (unmergedEntry) {
        entries.push(unmergedEntry)
      }
    }
  }

  await dropSharedSymlinkUntrackedEntries(worktreePath, entries, options.sharedLinkPaths ?? [])

  if (statusSucceeded && !didHitLimit && shouldProbeEffectiveUpstreamStatus(branch, upstreamName)) {
    const branchName = getShortBranchName(branch)
    if (branchName) {
      const cacheKey = getEffectiveUpstreamStatusCacheKey(
        worktreePath,
        branchName,
        upstreamName,
        options
      )
      try {
        // Why: the shared probe/caches serve concurrent reads, so run it unbound from this signal — one abort mustn't reject it for others.
        const { signal: _requestSignal, ...sharedProbeOptions } = options
        effectiveUpstreamStatus = await readOrProbeEffectiveUpstreamStatus(
          cacheKey,
          worktreePath,
          branchName,
          sharedProbeOptions,
          options.bypassEffectiveUpstreamNegativeCache === true
        )
      } catch {
        // Why: don't fail status polling on a transient upstream-probe error; the explicit upstream path surfaces those.
      }
    }
  }

  // Why: line counts run only for areas with entries (clean tree = 0 calls); skip past the limit to avoid numstat over a huge set.
  let branchLineTotal: GitBranchLineTotal | undefined
  if (!didHitLimit) {
    const branchLineTotalInput = createBranchLineTotalInput(
      worktreePath,
      entries,
      options,
      statusSucceeded
    )
    const lineStats = await reuseOrRecomputeGitStatusLineStats({
      cacheKey: lineStatsCacheKey,
      head,
      entries,
      writeToken: lineStatsWriteToken,
      reuse: options.reuseLineStats === true,
      isAborted: () => options.signal?.aborted === true,
      recompute: () => attachLineStats(worktreePath, entries, options),
      ...(branchLineTotalInput ? { branchLineTotal: branchLineTotalInput } : {})
    })
    branchLineTotal = lineStats.branchLineTotal
  } else {
    clearGitStatusLineStatsCacheKey(lineStatsCacheKey, lineStatsWriteToken)
  }

  // Why: an abort after the stream (unmerged/upstream/line-stats work) must still reject, not resolve.
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
    ...(options.includeIgnored ? { ignoredPaths: parser.ignoredPaths } : {}),
    ...(branchLineTotal ? { branchLineTotal } : {}),
    ...(didHitLimit ? { didHitLimit: true, statusLength: parser.statusLength } : {}),
    ...(statusSucceeded
      ? {
          upstreamStatus:
            effectiveUpstreamStatus ??
            (upstreamName
              ? {
                  hasUpstream: true,
                  upstreamName,
                  ahead: upstreamAheadBehind?.ahead ?? 0,
                  behind: upstreamAheadBehind?.behind ?? 0
                }
              : { hasUpstream: false, ahead: 0, behind: 0 })
        }
      : {})
  }
}
