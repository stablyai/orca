/* eslint-disable max-lines */
import { existsSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import type {
  GitBranchChangeEntry,
  GitBranchChangeStatus,
  GitBranchCompareResult,
  GitBranchCompareSummary,
  GitCommitCompareResult,
  GitConflictKind,
  GitConflictOperation,
  GitDiffResult,
  GitFileStatus,
  GitStatusEntry,
  GitStatusResult,
  GitUpstreamStatus
} from '../../shared/types'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'
import {
  getEffectiveGitUpstreamStatus,
  getGitUpstreamStatusForUpstreamName,
  splitRemoteBranchName
} from '../../shared/git-effective-upstream'
import { createGitConfigSnapshotRunner } from '../../shared/git-config-snapshot-runner'
import { isBinaryBuffer } from '../../shared/binary-buffer'
import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from '../../shared/git-uncommitted-line-stats'
import { decodeGitCQuotedPath } from '../../shared/git-cquoted-path'
import {
  gitExecFileAsync,
  gitExecFileAsyncBuffer,
  gitOptionalLocksDisabledEnv,
  gitStreamStdout
} from './runner'
import { StatusPorcelainParser } from './status-porcelain-parser'
import { DEFAULT_GIT_STATUS_LIMIT } from '../../shared/git-status-limit'
import { describeMaxBufferOverflowError, isMaxBufferOverflowError } from './max-buffer-overflow'
import {
  removeSafeUntrackedDiscardTarget,
  removeSafeUntrackedDiscardTargets
} from '../../shared/git-discard-path-safety'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree-base-ref'
import { hasWorktreeBaseCommitRef } from './worktree-base-ref-probe'
import { getLargeDiffRenderLimit } from '../../shared/large-diff-render-limit'
import { InFlightPromiseDedupe, stableInFlightKey } from '../../shared/in-flight-promise-dedupe'
import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { parseGitRevListFirstParentOid } from '../../shared/git-rev-list-output'
import {
  beginGitStatusLineStatsCacheWrite,
  clearGitStatusLineStatsCache,
  clearGitStatusLineStatsCacheKey,
  reuseOrRecomputeGitStatusLineStats
} from '../../shared/git-status-line-stats-cache'

const MAX_GIT_SHOW_BYTES = 10 * 1024 * 1024
const MAX_STAGED_COMMIT_CONTEXT_BYTES = MAX_GIT_SHOW_BYTES
const BULK_CHUNK_SIZE = 100
const EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_TTL_MS = 5 * 60_000
const MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES = 512

type EffectiveUpstreamStatusCacheEntry = {
  expiresAt: number
  status: GitUpstreamStatus
}

const SUBMODULE_PATHS_CACHE_TTL_MS = 5_000
export const MAX_SUBMODULE_PATHS_CACHE_ENTRIES = 512
type SubmodulePathsCacheEntry = { paths: string[]; expiresAt: number }
const submodulePathsCache = new Map<string, SubmodulePathsCacheEntry>()
let submodulePathsCacheGeneration = 0

// Why: cache the upstream name to skip its 4-5-spawn resolution chain each poll; revalidate via one rev-list (issue #7576).
const RESOLVED_UPSTREAM_NAME_CACHE_TTL_MS = 60_000

type ResolvedUpstreamNameCacheEntry = {
  upstreamName: string
  expiresAt: number
}

const resolvedUpstreamNameCache = new Map<string, ResolvedUpstreamNameCacheEntry>()

const effectiveUpstreamStatusCache = new Map<string, EffectiveUpstreamStatusCacheEntry>()
const effectiveUpstreamStatusInFlight = new Map<string, Promise<GitUpstreamStatus>>()
const retiredEffectiveUpstreamStatusInFlight = new Map<string, Promise<GitUpstreamStatus>>()
const gitDiffReadDedupe = new InFlightPromiseDedupe<GitDiffResult>()
const effectiveUpstreamStatusWriteGeneration = new Map<string, number>()
const statusReadsInFlight = new Map<string, Promise<GitStatusResult>>()

// Why: clear both diff and status in-flight caches; clearing only diff would let getStatus() join a pre-mutation read.
export function invalidateGitReadCaches(): void {
  gitDiffReadDedupe.clear()
  statusReadsInFlight.clear()
  clearGitStatusLineStatsCache()
  clearSubmodulePathsCache()
  resolvedUpstreamNameCache.clear()
}

export async function runWithGitReadCacheInvalidation<T>(run: () => Promise<T>): Promise<T> {
  invalidateGitReadCaches()
  try {
    return await run()
  } finally {
    // Why: a read that started mid-mutation can be stale too, so invalidate again after.
    invalidateGitReadCaches()
  }
}

export function clearSubmodulePathsCacheForTests(): void {
  clearSubmodulePathsCache()
}

function clearSubmodulePathsCache(): void {
  submodulePathsCache.clear()
  // Why: bump the generation so a pre-mutation read can't repopulate the invalidated cache.
  submodulePathsCacheGeneration += 1
}

export function getSubmodulePathsCacheCountForTests(): number {
  return submodulePathsCache.size
}

function gitRuntimeOptionsKey(options: GitRuntimeOptions): readonly unknown[] {
  return [options.wslDistro ?? null]
}

function getSubmodulePathsCacheKey(worktreePath: string, options: GitRuntimeOptions): string {
  // Why: the same path can map to different WSL-distro filesystems, so key the cache by runtime routing.
  return [worktreePath, ...gitRuntimeOptionsKey(options)].join('\0')
}

function pruneExpiredSubmodulePathsCache(now: number): void {
  for (const [cacheKey, entry] of submodulePathsCache) {
    if (entry.expiresAt <= now) {
      submodulePathsCache.delete(cacheKey)
    }
  }
}

function trimSubmodulePathsCache(): void {
  while (submodulePathsCache.size > MAX_SUBMODULE_PATHS_CACHE_ENTRIES) {
    const oldestKey = submodulePathsCache.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    submodulePathsCache.delete(oldestKey)
  }
}

function getCachedSubmodulePaths(cacheKey: string, now: number): string[] | null {
  const cached = submodulePathsCache.get(cacheKey)
  if (!cached) {
    return null
  }
  if (cached.expiresAt <= now) {
    submodulePathsCache.delete(cacheKey)
    return null
  }
  submodulePathsCache.delete(cacheKey)
  submodulePathsCache.set(cacheKey, cached)
  return cached.paths
}

function rememberSubmodulePaths(cacheKey: string, paths: string[], now: number): void {
  submodulePathsCache.delete(cacheKey)
  submodulePathsCache.set(cacheKey, { paths, expiresAt: now + SUBMODULE_PATHS_CACHE_TTL_MS })
  trimSubmodulePathsCache()
}

// Why: tests reuse this hook, so every memoization layer resets together despite the upstream-only name.
export function clearEffectiveUpstreamStatusCacheForTests(): void {
  effectiveUpstreamStatusCache.clear()
  effectiveUpstreamStatusInFlight.clear()
  retiredEffectiveUpstreamStatusInFlight.clear()
  effectiveUpstreamStatusWriteGeneration.clear()
  invalidateGitReadCaches()
}

export function getEffectiveUpstreamStatusCacheCountForTests(): number {
  return effectiveUpstreamStatusCache.size
}

export function getEffectiveUpstreamStatusGenerationCountForTests(): number {
  return effectiveUpstreamStatusWriteGeneration.size
}

export type GetStatusOptions = GitRuntimeOptions & {
  includeIgnored?: boolean
  reuseLineStats?: boolean
  /**
   * Max changed-file entries before git is stopped and the result is marked
   * `didHitLimit`. Defaults to DEFAULT_GIT_STATUS_LIMIT; 0 disables the cap.
   */
  limit?: number
  bypassEffectiveUpstreamNegativeCache?: boolean
}

/**
 * Parse `git status --porcelain=v2` output into structured entries.
 */
export async function getStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  gitDiffReadDedupe.clear()
  if (options.signal) {
    return runGetStatus(worktreePath, options)
  }
  // Why: dedupe only concurrent identical reads; after settle, callers must run a fresh read.
  const cacheKey = getStatusReadKey(worktreePath, options)
  const inFlightStatus = statusReadsInFlight.get(cacheKey)
  if (inFlightStatus) {
    return inFlightStatus
  }

  const statusPromise = runGetStatus(worktreePath, options)
  statusReadsInFlight.set(cacheKey, statusPromise)
  try {
    return await statusPromise
  } finally {
    if (statusReadsInFlight.get(cacheKey) === statusPromise) {
      statusReadsInFlight.delete(cacheKey)
    }
  }
}

function getStatusReadKey(worktreePath: string, options: GetStatusOptions): string {
  // Why: each key part can change the output shape or runtime routing.
  const limit =
    typeof options.limit === 'number' && Number.isInteger(options.limit) && options.limit >= 0
      ? options.limit
      : DEFAULT_GIT_STATUS_LIMIT
  return [
    worktreePath,
    options.wslDistro ?? '',
    options.includeIgnored === true,
    options.reuseLineStats === true,
    options.bypassEffectiveUpstreamNegativeCache === true,
    limit
  ].join('\0')
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
  const limit =
    typeof options.limit === 'number' && Number.isInteger(options.limit) && options.limit >= 0
      ? options.limit
      : DEFAULT_GIT_STATUS_LIMIT

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
  const conflictOperation = await conflictPromise

  try {
    const { stoppedEarly } = await gitStreamStdout(statusArgs, {
      cwd: worktreePath,
      wslDistro: options.wslDistro,
      // Why: status polling is read-like; disable optional locks to avoid racing terminal Git on index.lock.
      env: gitOptionalLocksDisabledEnv(),
      signal: options.signal,
      onStdout: (chunk) => parser.update(chunk, limit)
    })
    if (!stoppedEarly) {
      parser.finish()
    }
    didHitLimit = stoppedEarly
    statusSucceeded = true
  } catch (error) {
    // Why: an aborted scan must reject, not resolve as an empty result.
    if (options.signal?.aborted) {
      throw error
    }
    // Not a git repo or git not available
  }

  // Why: the parser overshoots by one (checks after pushing), so trim to exactly `limit`.
  const entries = didHitLimit ? parser.entries.slice(0, limit) : parser.entries
  const { head, branch, upstreamName, upstreamAheadBehind } = parser.branch

  // Why: unmerged (`u`) records need async per-file lookups; resolve them off the hot path (conflicts are rare).
  if (!didHitLimit) {
    for (const line of parser.unmergedLines) {
      const unmergedEntry = await parseUnmergedEntry(worktreePath, line)
      if (unmergedEntry) {
        entries.push(unmergedEntry)
      }
    }
  }

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
  if (!didHitLimit) {
    await reuseOrRecomputeGitStatusLineStats({
      cacheKey: lineStatsCacheKey,
      head,
      entries,
      writeToken: lineStatsWriteToken,
      reuse: options.reuseLineStats === true,
      isAborted: () => options.signal?.aborted === true,
      recompute: () => attachLineStats(worktreePath, entries, options)
    })
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

function getStatusLineStatsCacheKey(worktreePath: string, options: GitRuntimeOptions = {}): string {
  // Why: identical paths can map to different WSL-distro filesystems, so key stats by Git's execution host.
  return `${options.wslDistro ?? 'native'}\0${worktreePath}`
}

/**
 * Resolve a submodule's own worktree path from a parent worktree + relative
 * submodule path, rejecting anything that escapes the parent.
 */
export function resolveSubmoduleWorktreePath(worktreePath: string, submodulePath: string): string {
  if (!submodulePath || submodulePath.includes('\0') || path.isAbsolute(submodulePath)) {
    throw new Error('Access denied: invalid submodule path')
  }
  const resolved = path.resolve(worktreePath, submodulePath)
  const rel = path.relative(worktreePath, resolved)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('Access denied: submodule path escapes the selected worktree')
  }
  return resolved
}

/**
 * Run a plain status inside a submodule's own worktree (lazy "expand submodule"
 * flow). Entry paths are relative to the submodule root; the renderer prefixes them.
 */
export async function getSubmoduleStatus(
  worktreePath: string,
  submodulePath: string,
  options: GitRuntimeOptions & { staged?: boolean } = {}
): Promise<GitStatusResult> {
  const submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
  const workingResult = await getStatus(submoduleWorktreePath, options)
  // Why: a moved gitlink (clean worktree) has no status rows; surface the parent-commit→checkout range as inner rows.
  const fromOid = options.staged
    ? await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
    : (await readGitlinkOidFromIndex(worktreePath, submodulePath, options)) ||
      (await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options))
  const toOid = options.staged
    ? await readGitlinkOidFromIndex(worktreePath, submodulePath, options)
    : await readWorkingSubmoduleHead(submoduleWorktreePath, options)
  if (fromOid && toOid && fromOid !== toOid) {
    const rangeEntries = await computeSubmoduleRangeEntries(
      submoduleWorktreePath,
      fromOid,
      toOid,
      options
    )
    if (options.staged) {
      return { ...workingResult, entries: rangeEntries }
    }
    const rangePaths = new Set(rangeEntries.map((entry) => entry.path))
    // Range rows win on overlap so the diff matches getDiff's commit-range route.
    const entries = [
      ...rangeEntries,
      ...workingResult.entries.filter((entry) => !rangePaths.has(entry.path))
    ]
    return { ...workingResult, entries }
  }
  if (options.staged) {
    return { ...workingResult, entries: [] }
  }
  return workingResult
}

/**
 * List files changed between two submodule commits as status rows — used when a
 * gitlink pointer moved so the expanded submodule shows committed changes.
 */
async function computeSubmoduleRangeEntries(
  submoduleWorktreePath: string,
  fromOid: string,
  toOid: string,
  options: GitRuntimeOptions = {}
): Promise<GitStatusEntry[]> {
  const gitOptions = {
    ...gitOptionsForWorktree(submoduleWorktreePath, options),
    env: gitOptionalLocksDisabledEnv()
  }
  let nameStatus = ''
  let numstat = ''
  try {
    const [statusResult, numstatResult] = await Promise.all([
      gitExecFileAsync(
        ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', fromOid, toOid],
        gitOptions
      ),
      gitExecFileAsync(
        ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M', '-C', fromOid, toOid],
        gitOptions
      )
    ])
    nameStatus = statusResult.stdout
    numstat = numstatResult.stdout
  } catch {
    return []
  }
  const statsByPath = parseNumstat(numstat)
  const entries: GitStatusEntry[] = []
  for (const line of nameStatus.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const change = parseBranchChangeLine(line)
    if (!change) {
      continue
    }
    entries.push({
      path: change.path,
      status: change.status,
      area: 'unstaged',
      ...(change.oldPath ? { oldPath: change.oldPath } : {}),
      ...statsByPath.get(change.path)
    })
  }
  return entries
}

async function runNumstat(
  worktreePath: string,
  cached: boolean,
  options: GitRuntimeOptions = {}
): Promise<Map<string, GitLineStats> | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '-z',
        ...(cached ? ['--cached'] : []),
        '--numstat',
        '-M'
      ],
      { ...gitOptionsForWorktree(worktreePath, options), env: gitOptionalLocksDisabledEnv() }
    )
    return parseNumstat(stdout)
  } catch (error) {
    // Why: an aborted pass must reject; only a genuine numstat failure degrades to uncounted rows.
    if (options.signal?.aborted) {
      throw error
    }
    // Why: a numstat failure leaves rows uncounted; null (not empty map) flags the pass incomplete and uncacheable.
    return null
  }
}

/** Returns false when a numstat pass failed, so callers skip caching it. */
async function attachLineStats(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  if (entries.length === 0) {
    return true
  }
  const hasStaged = entries.some((entry) => entry.area === 'staged')
  const hasUnstaged = entries.some((entry) => entry.area === 'unstaged')
  const untrackedPaths = entries
    .filter((entry) => entry.area === 'untracked')
    .map((entry) => entry.path)
  const emptyStats = new Map<string, GitLineStats>()
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged ? runNumstat(worktreePath, true, options) : Promise.resolve(emptyStats),
    hasUnstaged ? runNumstat(worktreePath, false, options) : Promise.resolve(emptyStats),
    collectUntrackedAdditions(worktreePath, untrackedPaths, options.signal)
  ])
  for (const entry of entries) {
    applyLineStats(
      entry,
      entry.area === 'staged'
        ? (stagedStats ?? emptyStats).get(entry.path)
        : entry.area === 'unstaged'
          ? (unstagedStats ?? emptyStats).get(entry.path)
          : untrackedStats.get(entry.path)
    )
  }
  return stagedStats !== null && unstagedStats !== null
}

function getShortBranchName(branch: string | undefined): string | null {
  const prefix = 'refs/heads/'
  return branch?.startsWith(prefix) ? branch.slice(prefix.length) : null
}

function getEffectiveUpstreamStatusCacheKey(
  worktreePath: string,
  branchName: string,
  upstreamName: string | undefined,
  options: GitRuntimeOptions = {}
): string {
  return [worktreePath, options.wslDistro ?? 'host', branchName, upstreamName ?? ''].join('\0')
}

export function clearEffectiveUpstreamNegativeStatusCache(identity: {
  worktreePath: string
  branchName: string
  upstreamName?: string
  options?: GitRuntimeOptions
}): void {
  const cacheKey = getEffectiveUpstreamStatusCacheKey(
    identity.worktreePath,
    identity.branchName,
    identity.upstreamName,
    identity.options
  )
  retireEffectiveUpstreamStatusProbe(cacheKey)
  effectiveUpstreamStatusCache.delete(cacheKey)
  effectiveUpstreamStatusInFlight.delete(cacheKey)
  resolvedUpstreamNameCache.delete(cacheKey)
  effectiveUpstreamStatusWriteGeneration.set(
    cacheKey,
    (effectiveUpstreamStatusWriteGeneration.get(cacheKey) ?? 0) + 1
  )
}

function retireEffectiveUpstreamStatusProbe(cacheKey: string): void {
  const retiredProbe = effectiveUpstreamStatusInFlight.get(cacheKey)
  if (!retiredProbe) {
    return
  }
  retiredEffectiveUpstreamStatusInFlight.set(cacheKey, retiredProbe)
  void retiredProbe
    .finally(() => {
      if (retiredEffectiveUpstreamStatusInFlight.get(cacheKey) === retiredProbe) {
        retiredEffectiveUpstreamStatusInFlight.delete(cacheKey)
        trimEffectiveUpstreamStatusGeneration()
      }
    })
    .catch(() => undefined)
}

function hasPendingEffectiveUpstreamStatusProbe(cacheKey: string): boolean {
  return (
    effectiveUpstreamStatusInFlight.has(cacheKey) ||
    retiredEffectiveUpstreamStatusInFlight.has(cacheKey)
  )
}

function trimEffectiveUpstreamStatusGeneration(): void {
  for (const cacheKey of effectiveUpstreamStatusWriteGeneration.keys()) {
    if (
      effectiveUpstreamStatusWriteGeneration.size <= MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES
    ) {
      break
    }
    if (hasPendingEffectiveUpstreamStatusProbe(cacheKey)) {
      continue
    }
    effectiveUpstreamStatusWriteGeneration.delete(cacheKey)
  }
}

function readCachedEffectiveUpstreamStatus(
  cacheKey: string,
  now: number
): GitUpstreamStatus | undefined {
  const entry = effectiveUpstreamStatusCache.get(cacheKey)
  if (!entry) {
    return undefined
  }
  if (entry.expiresAt <= now) {
    effectiveUpstreamStatusCache.delete(cacheKey)
    return undefined
  }
  return entry.status
}

function rememberEffectiveUpstreamStatus(
  cacheKey: string,
  status: GitUpstreamStatus,
  now: number,
  probedSameNameOriginRef: boolean,
  writeGeneration: number
): void {
  // Why: hasConfiguredPushTarget gates a write action; re-probe each poll rather than cache a stale positive.
  if (status.hasUpstream || status.hasConfiguredPushTarget) {
    effectiveUpstreamStatusCache.delete(cacheKey)
    effectiveUpstreamStatusWriteGeneration.set(cacheKey, writeGeneration + 1)
    trimEffectiveUpstreamStatusGeneration()
    return
  }
  if ((effectiveUpstreamStatusWriteGeneration.get(cacheKey) ?? 0) !== writeGeneration) {
    return
  }
  if (!probedSameNameOriginRef) {
    return
  }
  // Why: cache the negative so a stable no-upstream branch doesn't re-probe every poll (TTL lets push/fetch refs appear).
  effectiveUpstreamStatusCache.set(cacheKey, {
    status,
    expiresAt: now + EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_TTL_MS
  })
  while (effectiveUpstreamStatusCache.size > MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES) {
    const oldest = effectiveUpstreamStatusCache.keys().next()
    if (oldest.done) {
      break
    }
    effectiveUpstreamStatusCache.delete(oldest.value)
    effectiveUpstreamStatusWriteGeneration.delete(oldest.value)
  }
  trimEffectiveUpstreamStatusGeneration()
}

async function readOrProbeEffectiveUpstreamStatus(
  cacheKey: string,
  worktreePath: string,
  branchName: string,
  options: GitRuntimeOptions = {},
  bypassCache = false
): Promise<GitUpstreamStatus> {
  if (!bypassCache) {
    const cached = readCachedEffectiveUpstreamStatus(cacheKey, Date.now())
    if (cached) {
      return cached
    }

    const inFlight = effectiveUpstreamStatusInFlight.get(cacheKey)
    if (inFlight) {
      return inFlight
    }
  }

  // Why: overlapping refreshes at startup — coalesce the upstream probe so a stable missing ref fails once.
  const writeGeneration = effectiveUpstreamStatusWriteGeneration.get(cacheKey) ?? 0
  const probe = probeOrRevalidateEffectiveUpstreamStatus(
    cacheKey,
    worktreePath,
    branchName,
    options,
    bypassCache
  ).then((result) => {
    rememberEffectiveUpstreamStatus(
      cacheKey,
      result.status,
      Date.now(),
      result.probedSameNameOriginRef,
      writeGeneration
    )
    return result.status
  })
  if (!bypassCache) {
    effectiveUpstreamStatusInFlight.set(cacheKey, probe)
  }
  try {
    return await probe
  } finally {
    if (effectiveUpstreamStatusInFlight.get(cacheKey) === probe) {
      effectiveUpstreamStatusInFlight.delete(cacheKey)
      trimEffectiveUpstreamStatusGeneration()
    }
  }
}

async function probeOrRevalidateEffectiveUpstreamStatus(
  cacheKey: string,
  worktreePath: string,
  branchName: string,
  options: GitRuntimeOptions = {},
  bypassCache = false
): Promise<{ status: GitUpstreamStatus; probedSameNameOriginRef: boolean }> {
  const now = Date.now()
  const cached = resolvedUpstreamNameCache.get(cacheKey)
  if (cached && (bypassCache || cached.expiresAt <= now)) {
    resolvedUpstreamNameCache.delete(cacheKey)
  } else if (cached) {
    try {
      const status = await getGitUpstreamStatusForUpstreamName(
        (args) => gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options)),
        cached.upstreamName
      )
      return { status, probedSameNameOriginRef: false }
    } catch (error) {
      // Why: an aborted probe says nothing about the ref; don't evict the warm name cache.
      if (options.signal?.aborted) {
        throw error
      }
      // Ref deleted or repo state changed — fall through to a full re-resolve.
      resolvedUpstreamNameCache.delete(cacheKey)
    }
  }
  const result = await probeEffectiveUpstreamStatus(worktreePath, branchName, options)
  if (result.status.hasUpstream && result.status.upstreamName) {
    resolvedUpstreamNameCache.set(cacheKey, {
      upstreamName: result.status.upstreamName,
      expiresAt: Date.now() + RESOLVED_UPSTREAM_NAME_CACHE_TTL_MS
    })
    while (resolvedUpstreamNameCache.size > MAX_EFFECTIVE_UPSTREAM_NEGATIVE_CACHE_ENTRIES) {
      const oldest = resolvedUpstreamNameCache.keys().next()
      if (oldest.done) {
        break
      }
      resolvedUpstreamNameCache.delete(oldest.value)
    }
  }
  return result
}

async function probeEffectiveUpstreamStatus(
  worktreePath: string,
  branchName: string,
  options: GitRuntimeOptions = {}
): Promise<{ status: GitUpstreamStatus; probedSameNameOriginRef: boolean }> {
  let probedSameNameOriginRef = false
  const snapshotRunner = createGitConfigSnapshotRunner((args) =>
    gitExecFileAsync(args, gitOptionsForWorktree(worktreePath, options))
  )
  const status = await getEffectiveGitUpstreamStatus((args) => {
    if (args[0] === 'rev-parse' && args.includes(`refs/remotes/origin/${branchName}`)) {
      probedSameNameOriginRef = true
    }
    return snapshotRunner(args)
  })
  return { status, probedSameNameOriginRef }
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

function parseBranchStatusChar(char: string): GitBranchChangeStatus {
  switch (char) {
    case 'M':
      return 'modified'
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified'
  }
}

async function parseUnmergedEntry(
  worktreePath: string,
  line: string
): Promise<GitStatusEntry | null> {
  // Why: porcelain v2 `u` records are space-separated (not tab); path is field 10+ and may contain spaces, so join the tail.
  const parts = line.split(' ')
  const xy = parts[1]
  const modeStage1 = parts[3]
  const modeStage2 = parts[4]
  const modeStage3 = parts[5]
  const filePath = decodeGitCQuotedPath(parts.slice(10).join(' '))
  if (!filePath) {
    return null
  }

  // Why: submodule conflicts (mode 160000) are out of scope for v1 — they need different resolution UX.
  if ([modeStage1, modeStage2, modeStage3].some((mode) => mode === '160000')) {
    return null
  }

  const conflictKind = parseConflictKind(xy)
  if (!conflictKind) {
    return null
  }

  // Why: porcelain v2 `u` records lack rename-origin metadata, so oldPath is intentionally omitted.
  return {
    path: filePath,
    area: 'unstaged',
    status: await getConflictCompatibilityStatus(worktreePath, filePath, conflictKind),
    conflictKind,
    conflictStatus: 'unresolved'
  }
}

function parseConflictKind(xy: string): GitConflictKind | null {
  switch (xy) {
    case 'UU':
      return 'both_modified'
    case 'AA':
      return 'both_added'
    case 'DD':
      return 'both_deleted'
    case 'AU':
      return 'added_by_us'
    case 'UA':
      return 'added_by_them'
    case 'DU':
      return 'deleted_by_us'
    case 'UD':
      return 'deleted_by_them'
    default:
      return null
  }
}

// Why: `status` here is a rendering-compat choice for icon/color plumbing, not semantic; the conflict badge carries the real meaning.
// Why: for deleted_by_*/added_by_* variants Git's result depends on merge strategy, so check the filesystem.
async function getConflictCompatibilityStatus(
  worktreePath: string,
  filePath: string,
  conflictKind: GitConflictKind
): Promise<GitFileStatus> {
  if (conflictKind === 'both_modified' || conflictKind === 'both_added') {
    return 'modified'
  }

  if (conflictKind === 'both_deleted') {
    return 'deleted'
  }

  try {
    return existsSync(path.join(worktreePath, filePath)) ? 'modified' : 'deleted'
  } catch {
    // Why: on an fs check failure, 'modified' is safer — it keeps the row visible rather than falsely showing 'deleted'.
    return 'modified'
  }
}

// Why: the git-status → existsSync race can miss a transient HEAD; fall back to 'unknown' for one poll cycle.
// Why: detect rebase from rebase-merge/ or rebase-apply/ dirs (persist all steps), not REBASE_HEAD (partial, lingers → stale badge).
export async function detectConflictOperation(worktreePath: string): Promise<GitConflictOperation> {
  const gitDir = await resolveGitDir(worktreePath)
  const mergeHead = path.join(gitDir, 'MERGE_HEAD')
  const cherryPickHead = path.join(gitDir, 'CHERRY_PICK_HEAD')
  const rebaseMergeDir = path.join(gitDir, 'rebase-merge')
  const rebaseApplyDir = path.join(gitDir, 'rebase-apply')

  let hasMergeHead = false
  let hasCherryPickHead = false
  let hasRebaseDir = false

  try {
    hasMergeHead = existsSync(mergeHead)
    hasCherryPickHead = existsSync(cherryPickHead)
    hasRebaseDir = existsSync(rebaseMergeDir) || existsSync(rebaseApplyDir)
  } catch {
    return 'unknown'
  }

  if (hasMergeHead) {
    return 'merge'
  }
  if (hasRebaseDir) {
    return 'rebase'
  }
  if (hasCherryPickHead) {
    return 'cherry-pick'
  }
  return 'unknown'
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

export async function resolveGitDir(worktreePath: string): Promise<string> {
  const dotGitPath = path.join(worktreePath, '.git')

  try {
    const dotGitContents = await readFile(dotGitPath, 'utf-8')
    const match = dotGitContents.match(/^gitdir:\s*(.+)\s*$/m)
    if (match) {
      return path.resolve(worktreePath, match[1])
    }
  } catch {
    // `.git` is likely a directory in a non-worktree checkout.
  }

  return dotGitPath
}

/**
 * List configured submodule paths (relative, forward-slash) for a worktree, cached
 * briefly. Read from `.gitmodules` to avoid an index-wide `ls-files` scan.
 */
export async function listSubmodulePaths(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const now = Date.now()
  const cacheKey = getSubmodulePathsCacheKey(worktreePath, options)
  const cached = getCachedSubmodulePaths(cacheKey, now)
  if (cached) {
    return cached
  }
  // Why: prune on misses so removed worktrees don't accumulate; hot hits stay O(1).
  pruneExpiredSubmodulePathsCache(now)
  const cacheGeneration = submodulePathsCacheGeneration
  let paths: string[] = []
  try {
    const { stdout } = await gitExecFileAsync(
      ['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'],
      { ...gitOptionsForWorktree(worktreePath, options), env: gitOptionalLocksDisabledEnv() }
    )
    paths = stdout
      .split(/\r?\n/)
      .map((line) => {
        const spaceIndex = line.indexOf(' ')
        return spaceIndex === -1
          ? ''
          : line
              .slice(spaceIndex + 1)
              .trim()
              .replace(/\/+$/, '')
      })
      .filter((value) => value.length > 0)
  } catch {
    // No .gitmodules (or git config failure) — treat as a repo without submodules.
    paths = []
  }
  if (cacheGeneration === submodulePathsCacheGeneration) {
    rememberSubmodulePaths(cacheKey, paths, Date.now())
  }
  return paths
}

/**
 * Find the submodule whose root equals or contains `filePath`. Returns the
 * submodule path (forward-slash) or null when the path is not in a submodule.
 */
function findContainingSubmodule(submodulePaths: string[], filePath: string): string | null {
  const normalized = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
  let best: string | null = null
  for (const sub of submodulePaths) {
    if (normalized === sub || normalized.startsWith(`${sub}/`)) {
      // Prefer the longest match to support nested submodule roots.
      if (!best || sub.length > best.length) {
        best = sub
      }
    }
  }
  return best
}

async function readGitlinkOidFromTree(
  worktreePath: string,
  ref: string,
  submodulePath: string,
  options: GitRuntimeOptions
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(['ls-tree', ref, '--', submodulePath], {
      ...gitOptionsForWorktree(worktreePath, options),
      env: gitOptionalLocksDisabledEnv()
    })
    return stdout.match(/^160000 commit ([0-9a-f]+)\t/m)?.[1] ?? ''
  } catch {
    return ''
  }
}

async function readGitlinkOidFromIndex(
  worktreePath: string,
  submodulePath: string,
  options: GitRuntimeOptions
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(['ls-files', '-s', '--', submodulePath], {
      ...gitOptionsForWorktree(worktreePath, options),
      env: gitOptionalLocksDisabledEnv()
    })
    return stdout.match(/^160000 ([0-9a-f]+) /m)?.[1] ?? ''
  } catch {
    return ''
  }
}

async function readWorkingSubmoduleHead(
  submoduleWorktreePath: string,
  options: GitRuntimeOptions
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(['rev-parse', 'HEAD'], {
      ...gitOptionsForWorktree(submoduleWorktreePath, options),
      env: gitOptionalLocksDisabledEnv()
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

/**
 * Synthesize a gitlink pointer diff: Git represents submodule commit changes as a
 * one-line `Subproject commit <oid>` swap, so the old/new oids feed the text differ.
 */
async function buildSubmodulePointerDiff(
  worktreePath: string,
  submodulePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions,
  // Why: default to the validated resolver so every caller is guarded against path escape.
  submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
): Promise<GitDiffResult> {
  let leftOid = ''
  let rightOid = ''
  if (staged) {
    leftOid = await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
    rightOid = await readGitlinkOidFromIndex(worktreePath, submodulePath, options)
  } else if (compareAgainstHead) {
    leftOid = await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options)
    rightOid = await readWorkingSubmoduleHead(submoduleWorktreePath, options)
  } else {
    leftOid =
      (await readGitlinkOidFromIndex(worktreePath, submodulePath, options)) ||
      (await readGitlinkOidFromTree(worktreePath, 'HEAD', submodulePath, options))
    rightOid = await readWorkingSubmoduleHead(submoduleWorktreePath, options)
  }
  return buildDiffResult(
    leftOid ? `Subproject commit ${leftOid}\n` : '',
    rightOid ? `Subproject commit ${rightOid}\n` : '',
    false,
    false,
    submodulePath
  )
}

/**
 * Diff a file inside a submodule across two of its commits — used when the parent
 * gitlink moved but the submodule worktree is clean (change is committed).
 */
async function buildSubmoduleInnerCommitRangeDiff(
  submoduleWorktreePath: string,
  innerPath: string,
  fromOid: string,
  toOid: string,
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  let originalContent = ''
  let modifiedContent = ''
  let originalIsBinary = false
  let modifiedIsBinary = false
  try {
    const left = await readGitBlobAtOidPath(submoduleWorktreePath, fromOid, innerPath, options)
    originalContent = left.content
    originalIsBinary = left.isBinary
    const right = await readGitBlobAtOidPath(submoduleWorktreePath, toOid, innerPath, options)
    modifiedContent = right.content
    modifiedIsBinary = right.isBinary
  } catch {
    // Fallback to empty content; a missing blob (add/delete) reads as one side.
  }
  return buildDiffResult(
    originalContent,
    modifiedContent,
    originalIsBinary,
    modifiedIsBinary,
    innerPath
  )
}

/**
 * Get original and modified content for diffing a file.
 */
export async function getDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead = false,
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  // Why: register the dedupe synchronously (before any await) so concurrent identical reads coalesce.
  return gitDiffReadDedupe.run(
    stableInFlightKey([
      'diff',
      worktreePath,
      filePath,
      staged,
      compareAgainstHead,
      ...gitRuntimeOptionsKey(options)
    ]),
    () => loadDiff(worktreePath, filePath, staged, compareAgainstHead, options)
  )
}

async function loadDiff(
  worktreePath: string,
  filePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  // Why: gitlink paths can't be read as blobs, so route submodule diffs explicitly (root → pointer, inner → recurse).
  const submodulePaths = await listSubmodulePaths(worktreePath, options)
  if (submodulePaths.length > 0) {
    const matchedSubmodule = findContainingSubmodule(submodulePaths, filePath)
    if (matchedSubmodule) {
      // Why: validate the .gitmodules-derived path against the worktree boundary so a crafted one can't escape the repo.
      const submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, matchedSubmodule)
      const normalizedFilePath = filePath.replace(/\\/g, '/').replace(/\/+$/, '')
      if (normalizedFilePath === matchedSubmodule) {
        return buildSubmodulePointerDiff(
          worktreePath,
          matchedSubmodule,
          staged,
          compareAgainstHead,
          options,
          submoduleWorktreePath
        )
      }
      const innerPath = normalizedFilePath.slice(matchedSubmodule.length + 1)
      const fromOid = staged
        ? await readGitlinkOidFromTree(worktreePath, 'HEAD', matchedSubmodule, options)
        : (await readGitlinkOidFromIndex(worktreePath, matchedSubmodule, options)) ||
          (await readGitlinkOidFromTree(worktreePath, 'HEAD', matchedSubmodule, options))
      const toOid = staged
        ? await readGitlinkOidFromIndex(worktreePath, matchedSubmodule, options)
        : await readWorkingSubmoduleHead(submoduleWorktreePath, options)
      // Why: a moved gitlink with a clean submodule worktree means the change is committed — diff the two commits.
      if (fromOid && toOid && fromOid !== toOid) {
        return buildSubmoduleInnerCommitRangeDiff(
          submoduleWorktreePath,
          innerPath,
          fromOid,
          toOid,
          options
        )
      }
      return getDiff(submoduleWorktreePath, innerPath, staged, compareAgainstHead, options)
    }
  }

  let originalContent = ''
  let modifiedContent = ''
  let originalIsBinary = false
  let modifiedIsBinary = false
  let modifiedDeleted = false

  try {
    const leftBlob = staged
      ? await readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
      : compareAgainstHead
        ? await readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
        : await readUnstagedLeftBlob(worktreePath, filePath, options)
    originalContent = leftBlob.content
    originalIsBinary = leftBlob.isBinary

    if (staged) {
      const rightBlob = await readGitBlobAtIndexPath(worktreePath, filePath, options)
      modifiedContent = rightBlob.content
      modifiedIsBinary = rightBlob.isBinary
      modifiedDeleted = !rightBlob.exists
    } else {
      const workingTreeBlob = await readWorkingTreeFile(path.join(worktreePath, filePath))
      modifiedContent = workingTreeBlob.content
      modifiedIsBinary = workingTreeBlob.isBinary
      modifiedDeleted = !workingTreeBlob.exists
    }
  } catch {
    // Fallback
  }

  const result = buildDiffResult(
    originalContent,
    modifiedContent,
    originalIsBinary,
    modifiedIsBinary,
    filePath
  )
  // Why: mark a proven deletion so previewers don't mistake a read failure's empty side for one.
  if (result.kind === 'binary' && modifiedDeleted) {
    return { ...result, modifiedDeleted: true }
  }
  return result
}

export async function getBranchCompare(
  worktreePath: string,
  baseRef: string,
  options: GitRuntimeOptions = {}
): Promise<GitBranchCompareResult> {
  const summary: GitBranchCompareSummary = {
    baseRef,
    baseOid: null,
    compareRef: 'HEAD',
    headOid: null,
    mergeBase: null,
    changedFiles: 0,
    status: 'loading'
  }

  const compareRef = await resolveCompareRef(worktreePath, options)
  summary.compareRef = compareRef
  // Why: short refs like "origin/main" can collide with a local branch; use the proven remote-tracking ref.
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, (qualifiedRef) =>
    hasWorktreeBaseCommitRef(worktreePath, qualifiedRef, options)
  )

  let headOid = ''
  let baseOid = ''
  try {
    headOid = await resolveRefOid(worktreePath, 'HEAD', options)
    summary.headOid = headOid
  } catch {
    try {
      baseOid = await resolveRefOid(worktreePath, resolvedBaseRef, options)
      summary.baseOid = baseOid
      // Why: an unborn branch (new remote worktree) has no changes yet; a compare error would look broken.
      summary.changedFiles = 0
      summary.commitsAhead = 0
      summary.status = 'ready'
      return { summary, entries: [] }
    } catch {
      // Preserve the unborn-head message when even the base is unresolvable.
    }
    summary.status = 'unborn-head'
    summary.errorMessage =
      'This branch does not have a committed HEAD yet, so compare-to-base is unavailable.'
    return { summary, entries: [] }
  }

  try {
    baseOid = await resolveRefOid(worktreePath, resolvedBaseRef, options)
    summary.baseOid = baseOid
  } catch {
    summary.status = 'invalid-base'
    summary.errorMessage = `Base ref ${baseRef} could not be resolved in this repository.`
    return { summary, entries: [] }
  }

  let mergeBase = ''
  try {
    mergeBase = await resolveMergeBase(worktreePath, baseOid, headOid, options)
    summary.mergeBase = mergeBase
  } catch {
    summary.status = 'no-merge-base'
    summary.errorMessage = `This branch and ${baseRef} do not share a merge base, so compare-to-base is unavailable.`
    return { summary, entries: [] }
  }

  try {
    const [entries, commitsAhead] = await Promise.all([
      loadBranchChanges(worktreePath, mergeBase, headOid, options),
      countAheadCommits(worktreePath, baseOid, headOid, options)
    ])
    summary.changedFiles = entries.length
    summary.commitsAhead = commitsAhead
    summary.status = 'ready'
    return { summary, entries }
  } catch (error) {
    summary.status = 'error'
    summary.errorMessage = error instanceof Error ? error.message : 'Failed to load branch compare'
    return { summary, entries: [] }
  }
}

export async function getBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  return gitDiffReadDedupe.run(
    stableInFlightKey([
      'branchDiff',
      worktreePath,
      args.headOid,
      args.mergeBase,
      args.filePath,
      args.oldPath ?? null,
      ...gitRuntimeOptionsKey(options)
    ]),
    () => loadBranchDiff(worktreePath, args, options)
  )
}

async function loadBranchDiff(
  worktreePath: string,
  args: {
    headOid: string
    mergeBase: string
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  try {
    const leftPath = args.oldPath ?? args.filePath
    const leftBlob = await readGitBlobAtOidPath(worktreePath, args.mergeBase, leftPath, options)
    const rightBlob = await readGitBlobAtOidPath(worktreePath, args.headOid, args.filePath, options)

    return buildDiffResult(
      leftBlob.content,
      rightBlob.content,
      leftBlob.isBinary,
      rightBlob.isBinary,
      args.filePath
    )
  } catch {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}

export async function getCommitCompare(
  worktreePath: string,
  commitId: string,
  options: GitRuntimeOptions = {}
): Promise<GitCommitCompareResult> {
  let commitOid = ''
  try {
    commitOid = await resolveRefOid(worktreePath, `${commitId}^{commit}`, options)
  } catch {
    return {
      summary: {
        commitOid: '',
        parentOid: null,
        compareRef: commitId,
        baseRef: 'parent',
        changedFiles: 0,
        status: 'invalid-commit',
        errorMessage: `Commit ${commitId} could not be resolved in this repository.`
      },
      entries: []
    }
  }

  const summary = {
    commitOid,
    parentOid: null as string | null,
    compareRef: commitOid.slice(0, 7),
    baseRef: 'empty tree',
    changedFiles: 0,
    status: 'ready' as const
  }

  try {
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--parents', '-n', '1', commitOid],
      gitOptionsForWorktree(worktreePath, options)
    )
    const firstParent = parseGitRevListFirstParentOid(stdout)
    summary.parentOid = firstParent
    summary.baseRef = firstParent ? firstParent.slice(0, 7) : 'empty tree'

    const entries = await loadCommitChanges(worktreePath, summary.parentOid, commitOid, options)
    summary.changedFiles = entries.length
    return { summary, entries }
  } catch (error) {
    return {
      summary: {
        ...summary,
        status: 'error',
        errorMessage: error instanceof Error ? error.message : 'Failed to load commit diff'
      },
      entries: []
    }
  }
}

export async function getCommitDiff(
  worktreePath: string,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions = {}
): Promise<GitDiffResult> {
  return gitDiffReadDedupe.run(
    stableInFlightKey([
      'commitDiff',
      worktreePath,
      args.commitOid,
      args.parentOid ?? null,
      args.filePath,
      args.oldPath ?? null,
      ...gitRuntimeOptionsKey(options)
    ]),
    () => loadCommitDiff(worktreePath, args, options)
  )
}

async function loadCommitDiff(
  worktreePath: string,
  args: {
    commitOid: string
    parentOid?: string | null
    filePath: string
    oldPath?: string
  },
  options: GitRuntimeOptions
): Promise<GitDiffResult> {
  try {
    const leftPath = args.oldPath ?? args.filePath
    const leftBlob = args.parentOid
      ? await readGitBlobAtOidPath(worktreePath, args.parentOid, leftPath, options)
      : { content: '', isBinary: false }
    const rightBlob = await readGitBlobAtOidPath(
      worktreePath,
      args.commitOid,
      args.filePath,
      options
    )

    return buildDiffResult(
      leftBlob.content,
      rightBlob.content,
      leftBlob.isBinary,
      rightBlob.isBinary,
      args.filePath
    )
  } catch {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
  }
}

async function loadBranchChanges(
  worktreePath: string,
  mergeBase: string,
  headOid: string,
  options: GitRuntimeOptions = {}
): Promise<GitBranchChangeEntry[]> {
  // Why: core.quotePath=false keeps real UTF-8 paths — see getStatus rationale.
  const gitOptions = {
    ...gitOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_GIT_SHOW_BYTES
  }
  // Why: both diffs are independent, so run them concurrently instead of serializing.
  const [{ stdout }, { stdout: numstat }] = await Promise.all([
    gitExecFileAsync(
      ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', mergeBase, headOid],
      gitOptions
    ),
    gitExecFileAsync(
      ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M', '-C', mergeBase, headOid],
      gitOptions
    )
  ])
  const statsByPath = parseNumstat(numstat)

  const entries: GitBranchChangeEntry[] = []
  // Why: split on /\r?\n/ so Git's CRLF output on Windows leaves no trailing \r in paths.
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const entry = parseBranchChangeLine(line)
    if (entry) {
      entries.push({ ...entry, ...statsByPath.get(entry.path) })
    }
  }
  return entries
}

async function loadCommitChanges(
  worktreePath: string,
  parentOid: string | null,
  commitOid: string,
  options: GitRuntimeOptions = {}
): Promise<GitBranchChangeEntry[]> {
  // Why: root commits have no parent tree; diff-tree --root uses git's empty tree, avoiding a hardcoded hash-format-specific oid.
  const args = parentOid
    ? ['-c', 'core.quotePath=false', 'diff', '--name-status', '-M', '-C', parentOid, commitOid]
    : [
        '-c',
        'core.quotePath=false',
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-status',
        '-r',
        '-M',
        '-C',
        commitOid
      ]
  const numstatArgs = parentOid
    ? ['-c', 'core.quotePath=false', 'diff', '-z', '--numstat', '-M', '-C', parentOid, commitOid]
    : [
        '-c',
        'core.quotePath=false',
        'diff-tree',
        '-z',
        '--root',
        '--no-commit-id',
        '--numstat',
        '-r',
        '-M',
        '-C',
        commitOid
      ]
  const gitOptions = {
    ...gitOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_GIT_SHOW_BYTES
  }
  // Why: the two git queries are independent, so run them in parallel.
  const [{ stdout }, { stdout: numstat }] = await Promise.all([
    gitExecFileAsync(args, gitOptions),
    gitExecFileAsync(numstatArgs, gitOptions)
  ])
  const statsByPath = parseNumstat(numstat)

  const entries: GitBranchChangeEntry[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      continue
    }
    const entry = parseBranchChangeLine(line)
    if (entry) {
      entries.push({ ...entry, ...statsByPath.get(entry.path) })
    }
  }
  return entries
}

function parseBranchChangeLine(line: string): GitBranchChangeEntry | null {
  const parts = line.split('\t')
  const rawStatus = parts[0] ?? ''
  const status = parseBranchStatusChar(rawStatus[0] ?? 'M')

  if (rawStatus.startsWith('R') || rawStatus.startsWith('C')) {
    const oldPath = decodeGitCQuotedPath(parts[1] ?? '')
    const path = decodeGitCQuotedPath(parts[2] ?? '')
    if (!path) {
      return null
    }
    return { path, oldPath, status }
  }

  const path = decodeGitCQuotedPath(parts[1] ?? '')
  if (!path) {
    return null
  }

  return { path, status }
}

async function resolveCompareRef(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  try {
    const { stdout } = await gitExecFileAsync(['branch', '--show-current'], {
      ...gitOptionsForWorktree(worktreePath, options)
    })
    const branch = stdout.trim()
    return branch || 'HEAD'
  } catch {
    return 'HEAD'
  }
}

async function resolveRefOid(
  worktreePath: string,
  ref: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['rev-parse', '--verify', '--end-of-options', ref], {
    ...gitOptionsForWorktree(worktreePath, options)
  })
  return stdout.trim()
}

async function resolveMergeBase(
  worktreePath: string,
  baseOid: string,
  headOid: string,
  options: GitRuntimeOptions = {}
): Promise<string> {
  const { stdout } = await gitExecFileAsync(['merge-base', baseOid, headOid], {
    ...gitOptionsForWorktree(worktreePath, options)
  })
  return stdout.trim()
}

async function countAheadCommits(
  worktreePath: string,
  baseOid: string,
  headOid: string,
  options: GitRuntimeOptions = {}
): Promise<number> {
  const { stdout } = await gitExecFileAsync(['rev-list', '--count', `${baseOid}..${headOid}`], {
    ...gitOptionsForWorktree(worktreePath, options)
  })
  return Number.parseInt(stdout.trim(), 10) || 0
}

async function readUnstagedLeftBlob(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  const indexBlob = await readGitBlobAtIndexPath(worktreePath, filePath, options)
  if (indexBlob.exists) {
    return indexBlob
  }

  return readGitBlobAtOidPath(worktreePath, 'HEAD', filePath, options)
}

async function readGitBlobAtIndexPath(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Why: Git's `:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(['show', `:${gitPath}`], {
      ...gitOptionsForWorktree(worktreePath, options),
      maxBuffer: MAX_GIT_SHOW_BYTES
    })

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    return { content: '', isBinary: false, exists: false }
  }
}

async function readGitBlobAtOidPath(
  worktreePath: string,
  oid: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<GitBlobReadResult> {
  // Why: Git's `<oid>:<path>` syntax expects forward slashes even on Windows.
  const gitPath = filePath.replace(/\\/g, '/')
  try {
    const { stdout } = await gitExecFileAsyncBuffer(
      ['show', '--end-of-options', `${oid}:${gitPath}`],
      {
        ...gitOptionsForWorktree(worktreePath, options),
        maxBuffer: MAX_GIT_SHOW_BYTES
      }
    )

    return { ...bufferToBlob(stdout, filePath), exists: true }
  } catch (error) {
    if (isMaxBufferOverflowError(error)) {
      return { content: '', isBinary: true, exists: true }
    }
    return { content: '', isBinary: false, exists: false }
  }
}

async function readWorkingTreeFile(filePath: string): Promise<GitBlobReadResult> {
  let fileStat
  try {
    fileStat = await stat(filePath)
  } catch (error) {
    // Why: only ENOENT is a real deletion; other stat errors are read failures, not absence.
    return {
      content: '',
      isBinary: false,
      exists: (error as NodeJS.ErrnoException)?.code !== 'ENOENT'
    }
  }
  if (!fileStat.isFile()) {
    return { content: '', isBinary: false, exists: false }
  }
  if (fileStat.size > MAX_GIT_SHOW_BYTES) {
    // Why: mirror git's maxBuffer cap for working-tree reads so readFile can't pull in huge assets.
    return { content: '', isBinary: true, exists: true }
  }
  try {
    const buffer = await readFile(filePath)
    return bufferToBlob(buffer, filePath)
  } catch {
    // Why: the file exists but could not be read — a read failure, not a deletion.
    return { content: '', isBinary: false, exists: true }
  }
}

function bufferToBlob(buffer: Buffer, filePath?: string): GitBlobReadResult {
  const isBinary = isBinaryBuffer(buffer)
  // Return base64 for recognized image formats so the renderer can display them
  const isPreviewableBinary = filePath
    ? !!PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
    : false
  return {
    content: isBinary
      ? isPreviewableBinary
        ? buffer.toString('base64')
        : ''
      : buffer.toString('utf-8'),
    isBinary,
    exists: true
  }
}

function buildDiffResult(
  originalContent: string,
  modifiedContent: string,
  originalIsBinary: boolean,
  modifiedIsBinary: boolean,
  filePath?: string
): GitDiffResult {
  if (originalIsBinary || modifiedIsBinary) {
    const mimeType = filePath
      ? PREVIEWABLE_BINARY_MIME_TYPES[path.extname(filePath).toLowerCase()]
      : undefined
    return {
      kind: 'binary',
      originalContent,
      modifiedContent,
      originalIsBinary,
      modifiedIsBinary,
      // Why: renderer still checks legacy `isImage` before previewing, so set it for PDFs too until the contract is renamed.
      ...(mimeType ? { isImage: true, mimeType } : {})
    } as GitDiffResult
  }

  // Why: over the render limit, return metadata instead of huge text so the renderer can show fallback UI.
  const largeDiffRenderLimit = getLargeDiffRenderLimit({ originalContent, modifiedContent })
  if (largeDiffRenderLimit.limited) {
    return {
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false,
      largeDiffRenderLimit
    }
  }

  return {
    kind: 'text',
    originalContent,
    modifiedContent,
    originalIsBinary: false,
    modifiedIsBinary: false
  }
}

type GitBlobReadResult = {
  content: string
  isBinary: boolean
  exists: boolean
}

const PREVIEWABLE_BINARY_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf'
}

/**
 * Stage a file.
 */
export async function stageFile(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  try {
    await gitExecFileAsync(
      ['add', '--', literalPathspec(filePath, options)],
      gitOptionsForWorktree(worktreePath, options)
    )
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Unstage a file.
 */
export async function unstageFile(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  try {
    await gitExecFileAsync(['restore', '--staged', '--', literalPathspec(filePath, options)], {
      ...gitOptionsForWorktree(worktreePath, options)
    })
  } finally {
    invalidateGitReadCaches()
  }
}

export async function getStagedCommitContext(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<CommitMessageDraftContext | null> {
  const branchPromise = gitExecFileAsync(['branch', '--show-current'], {
    ...gitOptionsForWorktree(worktreePath, options)
  }).catch(() => ({ stdout: '' }))
  const summaryPromise = gitExecFileAsync(['diff', '--cached', '--name-status'], {
    ...gitOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_STAGED_COMMIT_CONTEXT_BYTES
  })

  const [branchResult, summaryResult] = await Promise.all([branchPromise, summaryPromise])
  const stagedSummary = summaryResult.stdout.trim()
  if (!stagedSummary) {
    return null
  }

  let stagedPatch = ''
  try {
    const patchResult = await gitExecFileAsync(
      ['diff', '--cached', '--patch', '--minimal', '--no-color', '--no-ext-diff'],
      {
        ...gitOptionsForWorktree(worktreePath, options),
        maxBuffer: MAX_STAGED_COMMIT_CONTEXT_BYTES
      }
    )
    stagedPatch = patchResult.stdout
  } catch (error) {
    if (!isMaxBufferOverflowError(error)) {
      throw error
    }
    // Why: staged patch is optional context (truncated later anyway); degrade to file-name summary rather than fail.
    console.warn(
      '[git] Staged patch too large to read; using file summary only:',
      describeMaxBufferOverflowError(error)
    )
  }

  return {
    branch: branchResult.stdout.trim() || null,
    stagedSummary,
    stagedPatch
  }
}

export async function commitChanges(
  worktreePath: string,
  message: string,
  options: GitRuntimeOptions = {}
): Promise<{ success: boolean; error?: string }> {
  invalidateGitReadCaches()
  try {
    await gitExecFileAsync(['commit', '-m', message], gitOptionsForWorktree(worktreePath, options))
    return { success: true }
  } catch (error) {
    // Why: useful message may be on stderr (hook/GPG failures) or stdout ("nothing to commit"), so try both then message.
    const readStringField = (field: string): string | null => {
      if (typeof error === 'object' && error && field in error) {
        const v = (error as Record<string, unknown>)[field]
        if (typeof v === 'string' && v.length > 0) {
          return v
        }
      }
      return null
    }
    const errorMessage =
      readStringField('stderr') ??
      readStringField('stdout') ??
      (error instanceof Error ? error.message : 'Commit failed')
    return { success: false, error: errorMessage }
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Discard working tree changes for a file.
 */
export async function discardChanges(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  const resolvedWorktree = path.resolve(worktreePath)
  const resolvedTarget = path.resolve(worktreePath, filePath)
  try {
    if (!isWithinWorktree(path, resolvedWorktree, resolvedTarget)) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }

    let tracked = false
    try {
      await gitExecFileAsync(
        ['ls-files', '--error-unmatch', '--', literalPathspec(filePath, options)],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
      tracked = true
    } catch {
      // File is not tracked by git
    }

    if (tracked) {
      await gitExecFileAsync(
        ['restore', '--worktree', '--source=HEAD', '--', literalPathspec(filePath, options)],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
      return
    }

    await removeSafeUntrackedDiscardTarget(worktreePath, filePath, (targetPath) =>
      cleanUntrackedPaths(worktreePath, [targetPath], options)
    )
  } finally {
    invalidateGitReadCaches()
  }
}

function normalizeGitPathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
}

function literalPathspec(filePath: string, options: GitRuntimeOptions): string {
  // Why: Git inside WSL needs POSIX paths, but host paths must stay literal, so convert backslashes only for WSL.
  const runtimePath = options.wslDistro ? filePath.replace(/\\/g, '/') : filePath
  return `:(literal)${runtimePath}`
}

function isTrackedPathSpec(filePath: string, trackedPaths: readonly string[]): boolean {
  const normalized = normalizeGitPathForCompare(filePath)
  return trackedPaths.some((trackedPath) => {
    const normalizedTracked = normalizeGitPathForCompare(trackedPath)
    return normalizedTracked === normalized || normalizedTracked.startsWith(`${normalized}/`)
  })
}

async function listTrackedPathSpecs(
  worktreePath: string,
  filePaths: readonly string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const trackedPaths: string[] = []
  for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
    const { stdout } = await gitExecFileAsync(
      ['ls-files', '-z', '--', ...chunk.map((filePath) => literalPathspec(filePath, options))],
      {
        ...gitOptionsForWorktree(worktreePath, options)
      }
    )
    // Why: a tracked directory can hold enough paths to exceed the JS argument limit.
    for (const trackedPath of stdout.split('\0')) {
      if (trackedPath) {
        trackedPaths.push(trackedPath)
      }
    }
  }
  return trackedPaths
}

async function cleanUntrackedPaths(
  worktreePath: string,
  filePaths: readonly string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
    if (chunk.length > 0) {
      // Why: Git pathspec cleanup avoids raw recursive deletion through symlinked parents.
      await gitExecFileAsync(
        ['clean', '-ffdx', '--', ...chunk.map((filePath) => literalPathspec(filePath, options))],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
    }
  }
}

/**
 * Discard working tree changes for many paths in a small number of subprocesses.
 */
export async function bulkDiscardChanges(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }

  try {
    const resolvedWorktree = path.resolve(worktreePath)
    for (const filePath of filePaths) {
      const resolvedTarget = path.resolve(worktreePath, filePath)
      if (!isWithinWorktree(path, resolvedWorktree, resolvedTarget)) {
        throw new Error(`Path "${filePath}" resolves outside the worktree`)
      }
    }

    const trackedPathSpecs = await listTrackedPathSpecs(worktreePath, filePaths, options)
    const trackedPaths = filePaths.filter((filePath) =>
      isTrackedPathSpec(filePath, trackedPathSpecs)
    )
    const untrackedPaths = filePaths.filter(
      (filePath) => !isTrackedPathSpec(filePath, trackedPathSpecs)
    )
    await removeSafeUntrackedDiscardTargets(
      worktreePath,
      untrackedPaths,
      (targetPaths) => cleanUntrackedPaths(worktreePath, targetPaths, options),
      async () => {
        for (let i = 0; i < trackedPaths.length; i += BULK_CHUNK_SIZE) {
          const chunk = trackedPaths.slice(i, i + BULK_CHUNK_SIZE)
          await gitExecFileAsync(
            [
              'restore',
              '--worktree',
              '--source=HEAD',
              '--',
              ...chunk.map((filePath) => literalPathspec(filePath, options))
            ],
            {
              ...gitOptionsForWorktree(worktreePath, options)
            }
          )
        }
      }
    )
  } finally {
    invalidateGitReadCaches()
  }
}

export function isWithinWorktree(
  pathApi: Pick<typeof path, 'isAbsolute' | 'relative' | 'sep'>,
  resolvedWorktree: string,
  resolvedTarget: string
): boolean {
  const relativeTarget = pathApi.relative(resolvedWorktree, resolvedTarget)
  return !(
    relativeTarget === '' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativeTarget)
  )
}

/**
 * Bulk stage files in batches to avoid E2BIG.
 */
export async function bulkStageFiles(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }
  try {
    for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
      await gitExecFileAsync(
        ['add', '--', ...chunk.map((filePath) => literalPathspec(filePath, options))],
        gitOptionsForWorktree(worktreePath, options)
      )
    }
  } finally {
    invalidateGitReadCaches()
  }
}

/**
 * Bulk unstage files in batches to avoid E2BIG.
 */
export async function bulkUnstageFiles(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }
  try {
    for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
      const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
      await gitExecFileAsync(
        [
          'restore',
          '--staged',
          '--',
          ...chunk.map((filePath) => literalPathspec(filePath, options))
        ],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
    }
  } finally {
    invalidateGitReadCaches()
  }
}
