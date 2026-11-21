import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'
import { collectGitStatusLineStatInputs } from '../../../../shared/git/status/git-status-line-stat-inputs'
import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from '../../../../shared/git/status/git-uncommitted-line-stats'

import {
  type GitRuntimeOptions,
  gitReadOptionsForWorktree
} from '../../command-runner/git-runtime-options'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import { gitOptionalLocksDisabledEnv } from '../../command-runner/git-environment/git-process-env'
import { resolveWorktreeFilesystemPath } from '../worktree-filesystem-path'
import {
  beginIncompleteNumstatFallbackRead,
  clearIncompleteNumstatFallback,
  getIncompleteNumstatFallback,
  setIncompleteNumstatFallback,
  settledNumstatCache
} from '../git-read-cache-invalidation'
import { readStampedGitConfig, type StampedGitConfig } from '../input-stamps/stamped-git-config'
import { addGitattributesStampPaths } from '../input-stamps/gitattributes-stamp-paths'
import { readWorktreePathsDiffStamp } from '../input-stamps/worktree-diff-stamp'

/** A numstat pass; `complete` false means some rows could not be counted, so it must not be cached. */
type NumstatPass = {
  stats: Map<string, GitLineStats>
  complete: boolean
}

function numstatArgs(
  cached: boolean,
  detectRenames: boolean,
  pathspecs?: readonly string[]
): string[] {
  return [
    '-c',
    'core.quotePath=false',
    '-c',
    'diff.autoRefreshIndex=false',
    'diff',
    '-z',
    ...(cached ? ['--cached'] : []),
    '--numstat',
    detectRenames ? '-M' : '--no-renames',
    ...(pathspecs?.length ? ['--', ...pathspecs] : [])
  ]
}

async function runNumstat(
  worktreePath: string,
  cached: boolean,
  detectRenames: boolean,
  options: GitRuntimeOptions = {},
  pathspecs?: readonly string[]
): Promise<Map<string, GitLineStats>> {
  const { stdout } = await gitExecFileAsync(numstatArgs(cached, detectRenames, pathspecs), {
    ...gitReadOptionsForWorktree(worktreePath, options),
    env: gitOptionalLocksDisabledEnv()
  })
  return parseNumstat(stdout)
}

// One retry subprocess per row is only affordable on a rare failure, so cap the rows retried.
const MAX_NUMSTAT_RETRY_ENTRIES = 200

type NumstatEntryPass = NumstatPass & { failedPaths: Set<string> }

/** A locked file fails the whole pass on Windows; count each row alone so readable rows keep their stats. */
async function runNumstatPerEntry(
  worktreePath: string,
  cached: boolean,
  detectRenames: boolean,
  entries: readonly GitStatusEntry[],
  options: GitRuntimeOptions,
  backoffPaths: ReadonlySet<string> = new Set()
): Promise<NumstatEntryPass | null> {
  const area = cached ? 'staged' : 'unstaged'
  const areaEntries = entries.filter((entry) => entry.area === area)
  if (areaEntries.length === 0 || areaEntries.length > MAX_NUMSTAT_RETRY_ENTRIES) {
    return null
  }
  const stats = new Map<string, GitLineStats>()
  const failedPaths = new Set<string>()
  let complete = true
  for (const entry of areaEntries) {
    options.signal?.throwIfAborted()
    if (backoffPaths.has(entry.path)) {
      // Back off only the path that failed; every readable row is recounted from current files.
      complete = false
      failedPaths.add(entry.path)
      continue
    }
    try {
      // Literal magic keeps a path with wildcard characters from matching other files.
      const pathspecs = [
        `:(literal)${entry.path}`,
        ...(entry.oldPath === undefined ? [] : [`:(literal)${entry.oldPath}`])
      ]
      const entryStats = await runNumstat(worktreePath, cached, detectRenames, options, pathspecs)
      for (const [entryPath, lineStats] of entryStats) {
        stats.set(entryPath, lineStats)
      }
    } catch (error) {
      if (options.signal?.aborted) {
        throw error
      }
      // A still-unreadable row keeps empty stats; the pass stays incomplete.
      complete = false
      failedPaths.add(entry.path)
    }
  }
  return { stats, complete, failedPaths }
}

async function readNumstatWithFallback(
  worktreePath: string,
  cached: boolean,
  detectRenames: boolean,
  entries: readonly GitStatusEntry[],
  options: GitRuntimeOptions
): Promise<NumstatPass | null> {
  options.signal?.throwIfAborted()
  const readGeneration = beginIncompleteNumstatFallbackRead()
  const cachedFallback = getIncompleteNumstatFallback(worktreePath, cached, detectRenames)
  if (cachedFallback !== null) {
    const pass = await runNumstatPerEntry(
      worktreePath,
      cached,
      detectRenames,
      entries,
      options,
      cachedFallback.failedPaths
    )
    return pass === null ? null : { stats: pass.stats, complete: false }
  }
  try {
    const pass = {
      stats: await runNumstat(worktreePath, cached, detectRenames, options),
      complete: true
    }
    clearIncompleteNumstatFallback(worktreePath, cached, detectRenames)
    return pass
  } catch (error) {
    // Propagate cancellation; ordinary numstat failures may degrade to uncounted rows.
    if (options.signal?.aborted) {
      throw error
    }
  }
  const fallback = await runNumstatPerEntry(worktreePath, cached, detectRenames, entries, options)
  if (!fallback?.complete) {
    setIncompleteNumstatFallback(
      worktreePath,
      cached,
      detectRenames,
      fallback?.failedPaths ?? new Set(),
      readGeneration
    )
  } else {
    clearIncompleteNumstatFallback(worktreePath, cached, detectRenames)
  }
  return fallback
}

// Statting more files than this costs about as much as the numstat it would skip.
const MAX_STAMPED_PATHS = 512

/** Rollback switch: `ORCA_GIT_STATUS_NUMSTAT_REUSE=0` recomputes every numstat pass. */
function isNumstatReuseEnabled(): boolean {
  return process.env.ORCA_GIT_STATUS_NUMSTAT_REUSE !== '0'
}

/** Unstaged working files (unlisted ones would be status rows) plus every `.gitattributes` that applies; null if unstampable. */
function numstatStampPaths(entries: readonly GitStatusEntry[], cached: boolean): string[] | null {
  const area = cached ? 'staged' : 'unstaged'
  const workingPaths: string[] = []
  const attributePaths = new Set<string>(['.gitattributes'])
  for (const entry of entries) {
    if (entry.area !== area) {
      continue
    }
    // A gitlink's numstat follows the submodule's HEAD, which no parent file stamps.
    if (!cached && entry.submodule) {
      return null
    }
    for (const entryPath of entry.oldPath === undefined
      ? [entry.path]
      : [entry.path, entry.oldPath]) {
      if (!cached) {
        workingPaths.push(entryPath)
      }
      addGitattributesStampPaths(attributePaths, entryPath)
    }
    if (workingPaths.length + attributePaths.size > MAX_STAMPED_PATHS) {
      return null
    }
  }
  return [...workingPaths, ...attributePaths]
}

/** Reuse a numstat pass while HEAD, index, config, attributes and stamped working files are provably unchanged. */
async function readNumstatThroughSettledCache(
  worktreePath: string,
  cached: boolean,
  detectRenames: boolean,
  entries: readonly GitStatusEntry[],
  configRead: Promise<StampedGitConfig | null>,
  options: GitRuntimeOptions
): Promise<NumstatPass | null> {
  const readGeneration = settledNumstatCache.beginRead()
  const stampPaths = numstatStampPaths(entries, cached)
  // Null config means reuse is off or Git reads config and attributes the host cannot stamp (WSL).
  const config = stampPaths ? await configRead : null
  if (!stampPaths || !config) {
    return readNumstatWithFallback(worktreePath, cached, detectRenames, entries, options)
  }
  const stamp = await readWorktreePathsDiffStamp(worktreePath, stampPaths, options, [
    ...config.files,
    ...config.attributeFiles
  ])
  const readKey = JSON.stringify([worktreePath, cached, detectRenames])
  const reused = settledNumstatCache.get(readKey, stamp)
  if (reused) {
    return { stats: reused, complete: true }
  }
  const pass = await readNumstatWithFallback(worktreePath, cached, detectRenames, entries, options)
  if (pass?.complete) {
    settledNumstatCache.set(readKey, stamp, pass.stats, readGeneration)
  }
  return pass
}

/** Returns false when a numstat pass failed, so callers skip caching it. */
export async function attachLineStats(
  worktreePath: string,
  entries: GitStatusEntry[],
  options: GitRuntimeOptions = {}
): Promise<boolean> {
  if (entries.length === 0) {
    return true
  }
  const { hasStaged, hasUnstaged, hasStagedRenames, hasUnstagedRenames, untrackedPaths } =
    collectGitStatusLineStatInputs(entries)
  const emptyStats = new Map<string, GitLineStats>()
  const noEntriesPass: NumstatPass = { stats: emptyStats, complete: true }
  // One config read serves both passes.
  const configRead =
    (hasStaged || hasUnstaged) && isNumstatReuseEnabled()
      ? readStampedGitConfig(worktreePath, options)
      : Promise.resolve(null)
  // Approximates status's rename policy: -M only for areas where status reported a rename.
  const [stagedPass, unstagedPass, untrackedStats] = await Promise.all([
    hasStaged
      ? readNumstatThroughSettledCache(
          worktreePath,
          true,
          hasStagedRenames,
          entries,
          configRead,
          options
        )
      : Promise.resolve(noEntriesPass),
    hasUnstaged
      ? readNumstatThroughSettledCache(
          worktreePath,
          false,
          hasUnstagedRenames,
          entries,
          configRead,
          options
        )
      : Promise.resolve(noEntriesPass),
    // Node reads need host paths even when Git runs in WSL.
    collectUntrackedAdditions(
      resolveWorktreeFilesystemPath(worktreePath, options),
      untrackedPaths,
      options.signal
    )
  ])
  for (const entry of entries) {
    const area = entry.area
    applyLineStats(
      entry,
      area === 'staged'
        ? (stagedPass?.stats ?? emptyStats).get(entry.path)
        : area === 'unstaged'
          ? (unstagedPass?.stats ?? emptyStats).get(entry.path)
          : untrackedStats.get(entry.path)
    )
  }
  return stagedPass?.complete === true && unstagedPass?.complete === true
}
