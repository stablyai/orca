import type {
  GitBranchLineTotal,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../../../shared/git/status/git-status-types'
import { resolveGitStatusLimit } from '../../../../shared/git/status/git-status-limit'
import { stableInFlightKey } from '../../../../shared/in-flight-promise-dedupe'
import { beginGitStatusLineStatsCacheWrite } from '../../../../shared/git/status/git-status-line-stats-write-token'
import {
  clearGitStatusLineStatsCacheKey,
  reuseOrRecomputeGitStatusLineStats
} from '../../../../shared/git/status/git-status-line-stats-cache'
import { resolveWorktreeHostPath } from '../../../../shared/git/metadata/git-metadata-path'
import { readGitCommandFailureStderr } from '../../../../shared/git/commands/git-command-failure-text'
import { readStatusPorcelain } from './status-porcelain-stream'
import { waitForIndexLockRelease } from './status-index-lock-wait'
import {
  findExistingWorktreeSymlinkPaths,
  getSafeRelativePath
} from '../../worktrees/content-paths/worktree-symlink-detection'
import type { GetStatusOptions } from './get-status-options'
import { statusReadLeaseOwner } from '../git-read-cache-invalidation'
import { detectConflictOperation } from '../mutations/git-conflict-operation'
import { parseUnmergedEntry } from '../../../../shared/git/status/git-status-conflict-entries'
import { getEffectiveUpstreamStatusCacheKey } from '../upstream/effective-upstream-status-cache'
import {
  getShortBranchName,
  readOrProbeEffectiveUpstreamStatus,
  shouldProbeEffectiveUpstreamStatus
} from '../upstream/effective-upstream-status-probe'
import { attachLineStats } from './status-line-stats'
import {
  createBranchLineTotalInput,
  getStatusLineStatsCacheKey
} from './status-branch-line-total-input'
import { reconcileDriveCheckoutSuspects } from '../drive-checkout/drive-checkout-suspect-status'
import { markRecursiveSubmoduleRestores } from '../submodules/submodule-restore-recurse'
import { withRepositoryGitCause } from '../../repository-git-cause'

export async function getStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  // Reads preserve diff caches; mutations invalidate them and settled entries also validate input stamps.
  const cacheKey = getStatusReadKey(worktreePath, options)
  return statusReadLeaseOwner.lease(cacheKey, options.signal, (sharedSignal) =>
    withRepositoryGitCause(
      worktreePath,
      options,
      { family: 'status', reason: 'status-read', cache: 'miss' },
      () => runGetStatus(worktreePath, { ...options, signal: sharedSignal })
    )
  )
}

// Led by the worktree's line-stats key so an outside change can detach just that checkout's reads.
function getStatusReadKey(worktreePath: string, options: GetStatusOptions): string {
  const limit = resolveGitStatusLimit(options.limit)
  return `${getStatusLineStatsCacheKey(worktreePath, options)}\0${stableInFlightKey([
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
  ])}`
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

  // Inside the shared lease, so callers arriving during the wait join this read.
  await waitForIndexLockRelease(worktreePath, options)
  const conflictPromise = detectConflictOperation(worktreePath, options)
  const statusReadPromise = readStatusPorcelain(worktreePath, options, limit)
  const conflictOperation = await conflictPromise
  const { parser, stoppedEarly, error: statusError } = await statusReadPromise
  let didHitLimit = false
  if (statusError === undefined) {
    didHitLimit = stoppedEarly
    statusSucceeded = true
  } else {
    // Cancellation must reject rather than look like an empty status.
    if (options.signal?.aborted) {
      throw statusError
    }
    readError = describeStatusReadError(statusError)
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
