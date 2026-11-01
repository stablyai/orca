import type {
  GitBranchLineTotal,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../shared/git-status-types'
import { StatusPorcelainParser } from '../../../shared/git-status-porcelain-parser'
import { resolveGitStatusLimit } from '../../../shared/git-status-limit'
import { stableInFlightKey } from '../../../shared/in-flight-promise-dedupe'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCacheKey,
  reuseOrRecomputeGitStatusLineStats
} from '../../../shared/git-status-line-stats-cache'
import { resolveWorktreeHostPath } from '../../../shared/git-metadata-path'
import { readGitCommandFailureStderr } from '../../../shared/git-command-failure-text'
import { gitOptionalLocksDisabledEnv, gitStreamStdout } from '../runner'
import {
  findExistingWorktreeSymlinkPaths,
  getSafeRelativePath
} from '../worktree-symlink-detection'
import type { GetStatusOptions } from './get-status-options'
import { statusReadLeaseOwner } from './git-read-cache-invalidation'
import { detectConflictOperation } from './git-conflict-operation'
import { parseUnmergedEntry } from '../../../shared/git-status-conflict-entries'
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
import { reconcileDriveCheckoutSuspects } from './drive-checkout-suspect-status'
import { markRecursiveSubmoduleRestores } from './submodule-restore-recurse'

export async function getStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  // Reads preserve diff caches; mutations invalidate them and settled entries also validate input stamps.
  const cacheKey = getStatusReadKey(worktreePath, options)
  return statusReadLeaseOwner.lease(cacheKey, options.signal, (sharedSignal) =>
    runGetStatus(worktreePath, { ...options, signal: sharedSignal })
  )
}

function getStatusReadKey(worktreePath: string, options: GetStatusOptions): string {
  const limit = resolveGitStatusLimit(options.limit)
  return stableInFlightKey([
    worktreePath,
    options.wslDistro ?? '',
    options.admissionTier ?? 'status',
    options.includeIgnored === true,
    options.includeLineStats !== false,
    options.reuseLineStats === true,
    // Totals for different fork points or opt-in states cannot share a lease.
    options.branchLineTotalMergeBase ?? '',
    options.bypassEffectiveUpstreamNegativeCache === true,
    limit,
    // Filtering options affect which rows survive and must participate in the cache key.
    options.sharedLinkPaths ?? []
  ])
}

/** Hide only configured, real, untracked shared symlinks; directory-only Git ignore rules cannot hide them. */
async function dropSharedSymlinkUntrackedEntries(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GetStatusOptions
): Promise<void> {
  const sharedLinkPaths = options.sharedLinkPaths ?? []
  if (sharedLinkPaths.length === 0 || !entries.some((entry) => entry.area === 'untracked')) {
    return
  }
  const untrackedPaths = new Set(
    entries.filter((entry) => entry.area === 'untracked').map((entry) => entry.path)
  )
  const candidatePaths = sharedLinkPaths.filter((rawPath) => {
    const path = getSafeRelativePath(rawPath)
    return path.safe && untrackedPaths.has(path.rel)
  })
  if (candidatePaths.length === 0) {
    return
  }
  const sharedLinks = new Set(
    await findExistingWorktreeSymlinkPaths(worktreePath, candidatePaths, {
      wslDistro: options.wslDistro
    })
  )
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

// Git's stderr is unbounded and travels to remote clients; the first lines say what failed.
const STATUS_READ_ERROR_MAX_LENGTH = 1_000

function describeStatusReadError(error: unknown): string {
  const stderr = readGitCommandFailureStderr(error)?.trim()
  const text = stderr || (error instanceof Error ? error.message : String(error))
  return text.slice(0, STATUS_READ_ERROR_MAX_LENGTH)
}

async function runGetStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  const lineStatsCacheKey = getStatusLineStatsCacheKey(worktreePath, options)
  const lineStatsWriteToken =
    options.includeLineStats === false ? null : beginGitStatusLineStatsCacheWrite(lineStatsCacheKey)
  let effectiveUpstreamStatus: GitUpstreamStatus | undefined
  let statusSucceeded = false
  let readError: string | undefined
  const limit = resolveGitStatusLimit(options.limit)

  const conflictPromise = detectConflictOperation(worktreePath, options)
  // Keep non-ASCII paths readable instead of Git's octal escapes.
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

  // Bound streaming status so huge unignored folders cannot exhaust process memory.
  const parser = new StatusPorcelainParser()
  let didHitLimit = false
  // Own rejections before marker I/O so fast Git failures cannot become unhandled.
  const statusSettlementPromise = Promise.allSettled([
    (async () => {
      const result = await gitStreamStdout(statusArgs, {
        cwd: worktreePath,
        wslDistro: options.wslDistro,
        admissionTier: options.admissionTier,
        preferWslDirectGit: true,
        // Read-only polls must not compete with terminal Git for index.lock.
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
    // Cancellation must reject rather than look like an empty status.
    if (options.signal?.aborted) {
      throw error
    }
    readError = describeStatusReadError(error)
  }

  let entries: GitStatusEntry[] = []
  const { head, branch, upstreamName, upstreamAheadBehind } = parser.branch
  // Node filesystem probes need host paths even when Git reports guest spellings.
  const hostWorktreePath = resolveWorktreeHostPath(worktreePath, options) ?? worktreePath

  // Resolve conflicts in Git output order so the cap cannot hide early conflicts behind later ordinary rows.
  for (const record of parser.statusRecords) {
    if (didHitLimit && entries.length >= limit) {
      break
    }
    if (record.type === 'entry') {
      entries.push(record.entry)
    } else {
      const unmergedEntry = await parseUnmergedEntry(hostWorktreePath, record.line)
      if (unmergedEntry) {
        entries.push(unmergedEntry)
      }
    }
  }

  if (statusSucceeded && !didHitLimit) {
    entries = await reconcileDriveCheckoutSuspects(worktreePath, entries, options)
  }
  if (statusSucceeded) {
    entries = await markRecursiveSubmoduleRestores(worktreePath, entries, options)
  }
  await dropSharedSymlinkUntrackedEntries(worktreePath, entries, options)

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
        // Shared probes outlive individual callers; one abort must not reject other readers.
        const { signal: _requestSignal, ...sharedProbeOptions } = options
        effectiveUpstreamStatus = await readOrProbeEffectiveUpstreamStatus(
          cacheKey,
          worktreePath,
          branchName,
          sharedProbeOptions,
          options.bypassEffectiveUpstreamNegativeCache === true
        )
      } catch {
        // Polling tolerates upstream probe failures; explicit upstream actions surface them.
      }
    }
  }

  // Count only populated areas and skip truncated scans to avoid unbounded numstat work.
  let branchLineTotal: GitBranchLineTotal | undefined
  let branchLineTotalUnavailable: string | undefined
  if (!didHitLimit && lineStatsWriteToken !== null) {
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
    branchLineTotalUnavailable = lineStats.branchLineTotalUnavailable
  } else if (lineStatsWriteToken !== null) {
    clearGitStatusLineStatsCacheKey(lineStatsCacheKey, lineStatsWriteToken)
  }

  // Cancellation during follow-up probes must still reject.
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
    ...(readError !== undefined ? { readError } : {}),
    ...(options.includeIgnored ? { ignoredPaths: parser.ignoredPaths } : {}),
    ...(branchLineTotal ? { branchLineTotal } : {}),
    ...(branchLineTotalUnavailable ? { branchLineTotalUnavailable } : {}),
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
