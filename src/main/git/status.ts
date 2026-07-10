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
type SubmodulePathsCacheEntry = { paths: string[]; expiresAt: number }
const submodulePathsCache = new Map<string, SubmodulePathsCacheEntry>()

// Why: the effective-upstream resolution chain (symbolic-ref + rev-parse ×2-3
// + config snapshot) costs 4-5 subprocess spawns and only changes when branch
// or git config changes. Ahead/behind is a pure function of the two rev-list
// endpoints, so a recently-resolved name can be revalidated with one rev-list
// spawn per poll tick; a failed rev-list (deleted ref) falls back to a full
// re-resolve. Issue #7576: this path dominated idle main-process spawn churn.
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

// Why: a mutation invalidates both in-flight diff reads and in-flight status
// coalescing; clearing only the diff dedupe would let a post-mutation
// getStatus() join a pre-mutation read and return stale entries.
function clearGitReadInvalidationState(): void {
  gitDiffReadDedupe.clear()
  statusReadsInFlight.clear()
  submodulePathsCache.clear()
  resolvedUpstreamNameCache.clear()
}

export function clearSubmodulePathsCacheForTests(): void {
  submodulePathsCache.clear()
}

function gitRuntimeOptionsKey(options: GitRuntimeOptions): readonly unknown[] {
  return [options.wslDistro ?? null]
}

function getSubmodulePathsCacheKey(worktreePath: string, options: GitRuntimeOptions): string {
  // Why: the same path string can refer to different filesystem views across
  // WSL distros, so the `.gitmodules` cache must follow runtime routing.
  return [worktreePath, ...gitRuntimeOptionsKey(options)].join('\0')
}

// Why: status tests reuse this reset hook, so every cross-call memoization layer
// must reset together even though the historical name mentions upstream only.
export function clearEffectiveUpstreamStatusCacheForTests(): void {
  effectiveUpstreamStatusCache.clear()
  effectiveUpstreamStatusInFlight.clear()
  retiredEffectiveUpstreamStatusInFlight.clear()
  effectiveUpstreamStatusWriteGeneration.clear()
  clearGitReadInvalidationState()
}

export function getEffectiveUpstreamStatusCacheCountForTests(): number {
  return effectiveUpstreamStatusCache.size
}

export function getEffectiveUpstreamStatusGenerationCountForTests(): number {
  return effectiveUpstreamStatusWriteGeneration.size
}

export type GetStatusOptions = GitRuntimeOptions & {
  includeIgnored?: boolean
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
  // Why: dedupe only concurrent identical reads; after settle, callers must
  // execute a fresh status read rather than observing a cached result.
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
    options.bypassEffectiveUpstreamNegativeCache === true,
    limit
  ].join('\0')
}

async function runGetStatus(
  worktreePath: string,
  options: GetStatusOptions = {}
): Promise<GitStatusResult> {
  let effectiveUpstreamStatus: GitUpstreamStatus | undefined
  let statusSucceeded = false
  // Why: a negative/fractional/NaN limit would trigger spurious early-stop or
  // inconsistent truncation; fall back to the default unless it's a valid
  // non-negative integer (0 explicitly disables the cap).
  const limit =
    typeof options.limit === 'number' && Number.isInteger(options.limit) && options.limit >= 0
      ? options.limit
      : DEFAULT_GIT_STATUS_LIMIT

  // Why: detectConflictOperation (4 existsSync + readFile) and git status are
  // independent. Running them concurrently saves one round-trip of I/O latency.
  const conflictPromise = detectConflictOperation(worktreePath)
  // Why: -c core.quotePath=false keeps non-ASCII filenames (Japanese, emoji,
  // etc.) as raw UTF-8 instead of git's default C-style octal escapes wrapped
  // in double quotes. Without it, the parsed entry.path is unreadable in the
  // sidebar and downstream `git show :"docs/\346..."` lookups silently miss.
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

  // Why: stream + parse incrementally and stop git the moment the entry count
  // crosses `limit`, so a repo with an enormous un-ignored folder never buffers
  // a status listing big enough to crash the process. See StatusPorcelainParser.
  const parser = new StatusPorcelainParser()
  let didHitLimit = false
  const conflictOperation = await conflictPromise

  try {
    const { stoppedEarly } = await gitStreamStdout(statusArgs, {
      cwd: worktreePath,
      wslDistro: options.wslDistro,
      // Why: status polling is read-like; avoid refreshing the index and racing
      // terminal Git commands on `.git/worktrees/*/index.lock`.
      env: gitOptionalLocksDisabledEnv(),
      signal: options.signal,
      onStdout: (chunk) => parser.update(chunk, limit)
    })
    if (!stoppedEarly) {
      parser.finish()
    }
    didHitLimit = stoppedEarly
    statusSucceeded = true
  } catch {
    // Not a git repo or git not available
  }

  // Why: the parser stops one entry past the limit (it checks after pushing), so
  // trim back to exactly `limit` for a stable "first N shown" contract.
  const entries = didHitLimit ? parser.entries.slice(0, limit) : parser.entries
  const { head, branch, upstreamName, upstreamAheadBehind } = parser.branch

  // Why: unmerged (`u`) records need async per-file git lookups, so the parser
  // collected their raw lines; resolve them now. Conflicts are rare and never
  // the source of huge output, so this stays off the streamed hot path.
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
        effectiveUpstreamStatus = await readOrProbeEffectiveUpstreamStatus(
          cacheKey,
          worktreePath,
          branchName,
          options,
          options.bypassEffectiveUpstreamNegativeCache === true
        )
      } catch {
        // Why: git status polling should not fail just because the richer
        // upstream probe hit a transient ref/read error; the explicit
        // upstream-status path will surface those failures when invoked.
      }
    }
  }

  // Why: attach per-area line counts for the sidebar. Diffs run after status
  // (we need the entry list first) and only for areas that have entries, so a
  // clean tree costs zero extra git calls. Skipped when the limit was hit —
  // running numstat over a huge change set would reintroduce the cost the limit
  // exists to avoid, matching how a "huge" repo disables extra git features.
  if (!didHitLimit) {
    await attachLineStats(worktreePath, entries, options)
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

/**
 * Resolve a submodule's own worktree path from a parent worktree + relative
 * submodule path, rejecting anything that escapes the parent. Shared by the
 * on-demand submodule status query and the submodule-aware diff router.
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
 * Run a plain status inside a submodule's own worktree. Used by the lazy
 * "expand submodule" flow — the parent status only reports a single gitlink
 * row, so the inner per-file changes are fetched on demand here. Entry paths
 * are relative to the submodule root; the renderer prefixes them with the
 * submodule path.
 */
export async function getSubmoduleStatus(
  worktreePath: string,
  submodulePath: string,
  options: GitRuntimeOptions & { staged?: boolean } = {}
): Promise<GitStatusResult> {
  const submoduleWorktreePath = resolveSubmoduleWorktreePath(worktreePath, submodulePath)
  const workingResult = await getStatus(submoduleWorktreePath, options)
  // Why: a moved gitlink (clean worktree) has no uncommitted status rows; its
  // real changes live between the parent-recorded commit and the checked-out
  // commit. Surface those as inner rows so the expansion isn't empty.
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
 * List files changed between two submodule commits as status rows. Used when a
 * gitlink pointer moved so the expanded submodule shows the committed file
 * changes (each row diffs the file across the two commits).
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
): Promise<Map<string, GitLineStats>> {
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
  } catch {
    // Why: a numstat failure (e.g. transient lock) should leave rows without
    // counts rather than break the whole status refresh.
    return new Map()
  }
}

async function attachLineStats(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  if (entries.length === 0) {
    return
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
    collectUntrackedAdditions(worktreePath, untrackedPaths)
  ])
  for (const entry of entries) {
    applyLineStats(
      entry,
      entry.area === 'staged'
        ? stagedStats.get(entry.path)
        : entry.area === 'unstaged'
          ? unstagedStats.get(entry.path)
          : untrackedStats.get(entry.path)
    )
  }
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
  // Why: hasConfiguredPushTarget gates a write action. Re-probe it each poll
  // rather than keeping a stale positive target after branch config changes.
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
  // Why: a stable no-upstream branch should not spawn failed git probes every
  // source-control poll, but remote refs can appear after push/fetch.
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

  // Why: source-control mount and root git refresh can overlap during startup.
  // Coalesce the richer upstream probe so a stable missing ref fails once.
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
    } catch {
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
  // Why: porcelain v2 unmerged entries are fully space-separated (like type-1
  // ordinary entries), NOT tab-separated. The format is:
  //   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
  // The path starts at field index 10 and may contain spaces, so we join the
  // remaining fields. The earlier tab-based parsing silently dropped all
  // unmerged entries because the tab was never present.
  const parts = line.split(' ')
  const xy = parts[1]
  const modeStage1 = parts[3]
  const modeStage2 = parts[4]
  const modeStage3 = parts[5]
  const filePath = decodeGitCQuotedPath(parts.slice(10).join(' '))
  if (!filePath) {
    return null
  }

  // Why: submodule conflicts (mode 160000) are out of scope for v1.
  // Presenting them with normal file-conflict UX would be misleading because
  // submodule resolution requires different Git commands and user mental model.
  if ([modeStage1, modeStage2, modeStage3].some((mode) => mode === '160000')) {
    return null
  }

  const conflictKind = parseConflictKind(xy)
  if (!conflictKind) {
    return null
  }

  // Why: porcelain v2 `u` records do not provide rename-origin metadata (unlike
  // `2` records), so oldPath is intentionally omitted. v1 should not promise
  // rename ancestry in conflict rows without a separate Git query.
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

// Why: the `status` field on conflict entries is a *rendering compatibility*
// choice for existing icon/color plumbing, not a semantic claim about the file.
// The conflict badge and subtype carry the real meaning. We use 'modified' when
// a working-tree file exists and 'deleted' when it does not, so that downstream
// consumers (file explorer decorations, tab badges) get a reasonable fallback
// without needing conflict-aware upgrades in v1.
//
// For `deleted_by_us` / `deleted_by_them` and the `added_by_*` variants, Git's
// behavior depends on the merge strategy, so we check the filesystem rather
// than hardcoding an assumption.
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
    // Why: if the filesystem check throws (permissions error, unmounted path,
    // etc.), 'modified' is the safer fallback. It avoids suppressing the row
    // from the sidebar and avoids a misleading 'deleted' when we simply could
    // not check. The conflict badge still carries the real semantics.
    return 'modified'
  }
}

// Why: there is an inherent race between the `git status` call and these
// fs.existsSync checks — the HEAD file may not yet exist or may already be
// cleaned up by the time we check. In that case we fall back to 'unknown' for
// one poll cycle, which is acceptable. The renderer uses this to label the
// merge summary ("Merge conflicts" vs "Rebase conflicts" vs generic "Conflicts").
//
// Why rebase detection relies on rebase-merge/ or rebase-apply/ directories
// instead of REBASE_HEAD: those directories persist for the entire rebase, so
// they cover both conflicting and non-conflicting steps. REBASE_HEAD, by
// contrast, only exists on some steps and can also be left behind after a
// completed rebase, which would make the UI show a stale "Rebasing" badge.
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
  await gitExecFileAsync(['merge', '--abort'], gitOptionsForWorktree(worktreePath, options))
}

export async function abortRebase(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  await gitExecFileAsync(['rebase', '--abort'], gitOptionsForWorktree(worktreePath, options))
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
 * List configured submodule paths (relative, forward-slash) for a worktree,
 * cached briefly. Read from `.gitmodules` so a single diff click doesn't pay
 * for an index-wide `ls-files` scan. Used to route gitlink/inner diffs.
 */
export async function listSubmodulePaths(
  worktreePath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const now = Date.now()
  const cacheKey = getSubmodulePathsCacheKey(worktreePath, options)
  const cached = submodulePathsCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.paths
  }
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
  submodulePathsCache.set(cacheKey, { paths, expiresAt: now + SUBMODULE_PATHS_CACHE_TTL_MS })
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
 * Synthesize a gitlink pointer diff. Git represents submodule commit changes as
 * a one-line `Subproject commit <oid>` swap, so feeding the old/new oids through
 * the normal text differ matches git's own rendering.
 */
async function buildSubmodulePointerDiff(
  worktreePath: string,
  submodulePath: string,
  staged: boolean,
  compareAgainstHead: boolean,
  options: GitRuntimeOptions,
  // Why: default to the validated resolver so every caller (not just loadDiff)
  // is protected from a .gitmodules path escaping the parent worktree.
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
 * Diff a file inside a submodule across two of its commits. Used when the parent
 * gitlink moved but the submodule worktree is clean — the change is committed,
 * so compare the recorded commit's blob against the checked-out commit's blob.
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
  // Why: register the in-flight dedupe synchronously (before any await) so
  // concurrent identical reads coalesce; submodule routing happens inside.
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
  // Why: gitlink paths can't be read as blobs (`git show HEAD:<sub>` is a "bad
  // object") and a submodule working dir reads as empty, so route submodule
  // diffs explicitly: the gitlink root → pointer diff, inner files → recurse
  // into the submodule's own worktree.
  const submodulePaths = await listSubmodulePaths(worktreePath, options)
  if (submodulePaths.length > 0) {
    const matchedSubmodule = findContainingSubmodule(submodulePaths, filePath)
    if (matchedSubmodule) {
      // Why: matchedSubmodule originates from .gitmodules, so validate it against
      // the worktree boundary before any inner read — a crafted submodule path
      // must not let the diff escape the selected repo.
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
      // Why: when the gitlink moved but the submodule worktree is clean, the
      // file's change lives in committed history — diff the two commits. Only
      // fall back to the working-tree blob read when the commit didn't move.
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
    } else {
      const workingTreeBlob = await readWorkingTreeFile(path.join(worktreePath, filePath))
      modifiedContent = workingTreeBlob.content
      modifiedIsBinary = workingTreeBlob.isBinary
    }
  } catch {
    // Fallback
  }

  return buildDiffResult(
    originalContent,
    modifiedContent,
    originalIsBinary,
    modifiedIsBinary,
    filePath
  )
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
  // Why: short remote display refs like "origin/main" can collide with a local
  // branch of the same name. Compare against the proven remote-tracking ref.
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
      // Why: new remote worktrees can be on an unborn branch until the first
      // commit. There are no committed branch changes yet; surfacing this as a
      // compare error makes the source-control panel look broken.
      summary.changedFiles = 0
      summary.commitsAhead = 0
      summary.status = 'ready'
      return { summary, entries: [] }
    } catch {
      // Preserve the existing unborn-head message when even the base is not
      // resolvable; callers cannot compare or present a useful empty state.
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
  // Why: see core.quotePath=false rationale in getStatus — same reason here so
  // branch-diff entries render with their real UTF-8 paths.
  const gitOptions = {
    ...gitOptionsForWorktree(worktreePath, options),
    maxBuffer: MAX_GIT_SHOW_BYTES
  }
  // Why: both diffs walk the same range and are independent, so start them
  // together instead of serializing two potentially large git operations.
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
  // [Fix]: Split by /\r?\n/ instead of '\n' to handle Git CRLF output on Windows,
  // preventing trailing \r characters in extracted file paths.
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
  // Why: root commits have no parent tree; diff-tree --root asks git to
  // compare against the repository's empty tree without hardcoding hash format.
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
  // Why: commit diff rows need metadata and line counts, but those git queries
  // do not depend on each other.
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
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      return { content: '', isBinary: false, exists: false }
    }
    if (fileStat.size > MAX_GIT_SHOW_BYTES) {
      // Why: git blob reads are capped through maxBuffer; mirror that bound for
      // unstaged working-tree content before readFile can pull in huge assets.
      return { content: '', isBinary: true, exists: true }
    }
    const buffer = await readFile(filePath)
    return bufferToBlob(buffer, filePath)
  } catch {
    return { content: '', isBinary: false, exists: false }
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
      // Why: binary diff previews were originally image-only, so the renderer
      // still checks `isImage` before showing a preview component. Preserve
      // that legacy flag for PDFs until the wider contract is renamed.
      ...(mimeType ? { isImage: true, mimeType } : {})
    } as GitDiffResult
  }

  // Why: if the diff exceeds safe render limits, avoid sending large text
  // payloads and return metadata so the renderer can show fallback UI.
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
  clearGitReadInvalidationState()
  try {
    await gitExecFileAsync(
      ['add', '--', literalPathspec(filePath, options)],
      gitOptionsForWorktree(worktreePath, options)
    )
  } finally {
    clearGitReadInvalidationState()
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
  clearGitReadInvalidationState()
  try {
    await gitExecFileAsync(['restore', '--staged', '--', literalPathspec(filePath, options)], {
      ...gitOptionsForWorktree(worktreePath, options)
    })
  } finally {
    clearGitReadInvalidationState()
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
    // Why: a very large staged diff overflows maxBuffer (ENOBUFS). The patch is
    // optional context that gets truncated to STAGED_DIFF_BYTE_BUDGET anyway, so
    // degrade to the file-name summary instead of failing commit-message generation.
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
  clearGitReadInvalidationState()
  try {
    await gitExecFileAsync(['commit', '-m', message], gitOptionsForWorktree(worktreePath, options))
    return { success: true }
  } catch (error) {
    // Why: surface whichever channel carries the useful message. Pre-commit/GPG
    // hook failures write to stderr; "nothing to commit, working tree clean"
    // writes to stdout. Try stderr first, fall back to stdout, then error.message.
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
    clearGitReadInvalidationState()
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
  clearGitReadInvalidationState()
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
    clearGitReadInvalidationState()
  }
}

function normalizeGitPathForCompare(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/\/+$/, '')
}

function literalPathspec(filePath: string, options: GitRuntimeOptions): string {
  // Why: Windows validation produces backslashes, but Git running inside WSL
  // needs POSIX paths. Host paths stay untouched so POSIX filenames remain literal.
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
    // Why: a tracked directory can contain enough paths for push(...split)
    // to exceed the JavaScript argument limit before discard decisions run.
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
  clearGitReadInvalidationState()
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
    clearGitReadInvalidationState()
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
  clearGitReadInvalidationState()
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
    clearGitReadInvalidationState()
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
  clearGitReadInvalidationState()
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
    clearGitReadInvalidationState()
  }
}
