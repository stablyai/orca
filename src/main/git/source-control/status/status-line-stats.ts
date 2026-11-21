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
import { settledNumstatCache } from '../git-read-cache-invalidation'
import { readStampedGitConfig, type StampedGitConfig } from '../input-stamps/stamped-git-config'
import { addGitattributesStampPaths } from '../input-stamps/gitattributes-stamp-paths'
import { readWorktreePathsDiffStamp } from '../input-stamps/worktree-diff-stamp'

// A worktree-wide pass aborts on one unreadable file; re-reading in bounded chunks keeps every other row counted.
const NUMSTAT_FALLBACK_CHUNK_PATHS = 32
const MAX_NUMSTAT_FALLBACK_PATHS = 512

function numstatArgs(cached: boolean, detectRenames: boolean, paths?: readonly string[]): string[] {
  return [
    '-c',
    'core.quotePath=false',
    '-c',
    'diff.autoRefreshIndex=false',
    // A file name with glob characters must match itself, not a locked sibling.
    '--literal-pathspecs',
    'diff',
    '-z',
    ...(cached ? ['--cached'] : []),
    '--numstat',
    detectRenames ? '-M' : '--no-renames',
    ...(paths && paths.length > 0 ? ['--', ...paths] : [])
  ]
}

async function readNumstat(
  worktreePath: string,
  args: string[],
  options: GitRuntimeOptions
): Promise<Map<string, GitLineStats>> {
  const { stdout } = await gitExecFileAsync(args, {
    ...gitReadOptionsForWorktree(worktreePath, options),
    env: gitOptionalLocksDisabledEnv()
  })
  return parseNumstat(stdout)
}

function pathsForLineStatsArea(
  entries: readonly GitStatusEntry[],
  area: GitStatusEntry['area']
): string[] {
  const paths = new Set<string>()
  for (const entry of entries) {
    if (entry.area !== area) {
      continue
    }
    paths.add(entry.path)
    if (entry.oldPath !== undefined) {
      paths.add(entry.oldPath)
    }
  }
  return [...paths]
}

type NumstatRead = { stats: Map<string, GitLineStats>; complete: boolean }

/** One locked file fails its chunk; retry that chunk per path so only the unreadable row stays uncounted. */
async function runNumstatFallback(
  worktreePath: string,
  cached: boolean,
  detectRenames: boolean,
  paths: readonly string[],
  options: GitRuntimeOptions
): Promise<NumstatRead | null> {
  if (paths.length > MAX_NUMSTAT_FALLBACK_PATHS) {
    return null
  }
  const stats = new Map<string, GitLineStats>()
  let readAny = false
  let failed = false
  const read = async (subset: readonly string[]): Promise<void> => {
    const part = await readNumstat(
      worktreePath,
      numstatArgs(cached, detectRenames, subset),
      options
    )
    for (const [path, lineStats] of part) {
      stats.set(path, lineStats)
    }
    readAny = true
  }
  for (let start = 0; start < paths.length; start += NUMSTAT_FALLBACK_CHUNK_PATHS) {
    const chunk = paths.slice(start, start + NUMSTAT_FALLBACK_CHUNK_PATHS)
    try {
      await read(chunk)
    } catch (error) {
      if (options.signal?.aborted) {
        throw error
      }
      for (const path of chunk) {
        try {
          await read([path])
        } catch (singleError) {
          if (options.signal?.aborted) {
            throw singleError
          }
          failed = true
        }
      }
    }
  }
  return readAny ? { stats, complete: !failed } : null
}

async function runNumstat(
  worktreePath: string,
  cached: boolean,
  detectRenames: boolean,
  options: GitRuntimeOptions = {},
  fallbackPaths: readonly string[] = []
): Promise<NumstatRead | null> {
  try {
    return {
      stats: await readNumstat(worktreePath, numstatArgs(cached, detectRenames), options),
      complete: true
    }
  } catch (error) {
    // Propagate cancellation; ordinary numstat failures may degrade to uncounted rows.
    if (options.signal?.aborted) {
      throw error
    }
    if (fallbackPaths.length > 0) {
      return runNumstatFallback(worktreePath, cached, detectRenames, fallbackPaths, options)
    }
    // null marks the pass incomplete and uncacheable; an empty map would imply success.
    return null
  }
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
): Promise<NumstatRead | null> {
  const readGeneration = settledNumstatCache.beginRead()
  const stampPaths = numstatStampPaths(entries, cached)
  const fallbackPaths = pathsForLineStatsArea(entries, cached ? 'staged' : 'unstaged')
  // Null config means reuse is off or Git reads config and attributes the host cannot stamp (WSL).
  const config = stampPaths ? await configRead : null
  if (!stampPaths || !config) {
    return runNumstat(worktreePath, cached, detectRenames, options, fallbackPaths)
  }
  const stamp = await readWorktreePathsDiffStamp(worktreePath, stampPaths, options, [
    ...config.files,
    ...config.attributeFiles
  ])
  const readKey = JSON.stringify([worktreePath, cached, detectRenames])
  const reused = settledNumstatCache.get(readKey, stamp)
  if (reused) {
    // Only complete passes are stored, so a hit is always a complete read.
    return { stats: reused, complete: true }
  }
  const read = await runNumstat(worktreePath, cached, detectRenames, options, fallbackPaths)
  // An incomplete pass must not be cached: the next poll has to reread the failed paths.
  if (read?.complete) {
    settledNumstatCache.set(readKey, stamp, read.stats, readGeneration)
  }
  return read
}

/** Returns false when a numstat pass failed or left any path unread, so callers skip caching incomplete counts. */
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
  const emptyRead: NumstatRead = { stats: emptyStats, complete: true }
  // One config read serves both passes.
  const configRead =
    (hasStaged || hasUnstaged) && isNumstatReuseEnabled()
      ? readStampedGitConfig(worktreePath, options)
      : Promise.resolve(null)
  // Approximates status's rename policy: -M only for areas where status reported a rename.
  const [stagedRead, unstagedRead, untrackedStats] = await Promise.all([
    hasStaged
      ? readNumstatThroughSettledCache(
          worktreePath,
          true,
          hasStagedRenames,
          entries,
          configRead,
          options
        )
      : Promise.resolve(emptyRead),
    hasUnstaged
      ? readNumstatThroughSettledCache(
          worktreePath,
          false,
          hasUnstagedRenames,
          entries,
          configRead,
          options
        )
      : Promise.resolve(emptyRead),
    // Node reads need host paths even when Git runs in WSL.
    collectUntrackedAdditions(
      resolveWorktreeFilesystemPath(worktreePath, options),
      untrackedPaths,
      options.signal
    )
  ])
  const stagedStats = stagedRead?.stats ?? emptyStats
  const unstagedStats = unstagedRead?.stats ?? emptyStats
  for (const entry of entries) {
    const area = entry.area
    applyLineStats(
      entry,
      area === 'staged'
        ? stagedStats.get(entry.path)
        : area === 'unstaged'
          ? unstagedStats.get(entry.path)
          : untrackedStats.get(entry.path)
    )
  }
  // A partial pass keeps its readable rows but reports incomplete, so no snapshot pins the missing ones.
  return stagedRead?.complete === true && unstagedRead?.complete === true
}
