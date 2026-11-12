import type { GitStatusEntry } from '../../../shared/git/status/git-status-types'
import { collectGitStatusLineStatInputs } from '../../../shared/git/status/git-status-line-stat-inputs'
import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from '../../../shared/git/status/git-uncommitted-line-stats'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../command-runner/git-exec-file'
import { gitOptionalLocksDisabledEnv } from '../command-runner/git-environment/git-process-env'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { settledNumstatCache } from './git-read-cache-invalidation'
import { readStampedGitConfig, type StampedGitConfig } from './stamped-git-config'
import { addGitattributesStampPaths } from './gitattributes-stamp-paths'
import { readWorktreePathsDiffStamp } from './worktree-diff-stamp'

async function runNumstat(
  worktreePath: string,
  cached: boolean,
  detectRenames: boolean,
  options: GitRuntimeOptions = {}
): Promise<Map<string, GitLineStats> | null> {
  try {
    const { stdout } = await gitExecFileAsync(
      [
        '-c',
        'core.quotePath=false',
        '-c',
        'diff.autoRefreshIndex=false',
        'diff',
        '-z',
        ...(cached ? ['--cached'] : []),
        '--numstat',
        detectRenames ? '-M' : '--no-renames'
      ],
      {
        ...gitReadOptionsForWorktree(worktreePath, options),
        env: gitOptionalLocksDisabledEnv()
      }
    )
    return parseNumstat(stdout)
  } catch (error) {
    // Propagate cancellation; ordinary numstat failures may degrade to uncounted rows.
    if (options.signal?.aborted) {
      throw error
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
): Promise<Map<string, GitLineStats> | null> {
  const readGeneration = settledNumstatCache.beginRead()
  const stampPaths = numstatStampPaths(entries, cached)
  // Null config means reuse is off or Git reads config and attributes the host cannot stamp (WSL).
  const config = stampPaths ? await configRead : null
  if (!stampPaths || !config) {
    return runNumstat(worktreePath, cached, detectRenames, options)
  }
  const stamp = await readWorktreePathsDiffStamp(worktreePath, stampPaths, options, [
    ...config.files,
    ...config.attributeFiles
  ])
  const readKey = JSON.stringify([worktreePath, cached, detectRenames])
  const reused = settledNumstatCache.get(readKey, stamp)
  if (reused) {
    return reused
  }
  const stats = await runNumstat(worktreePath, cached, detectRenames, options)
  if (stats) {
    settledNumstatCache.set(readKey, stamp, stats, readGeneration)
  }
  return stats
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
  // One config read serves both passes.
  const configRead =
    (hasStaged || hasUnstaged) && isNumstatReuseEnabled()
      ? readStampedGitConfig(worktreePath, options)
      : Promise.resolve(null)
  // Approximates status's rename policy: -M only for areas where status reported a rename.
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged
      ? readNumstatThroughSettledCache(
          worktreePath,
          true,
          hasStagedRenames,
          entries,
          configRead,
          options
        )
      : Promise.resolve(emptyStats),
    hasUnstaged
      ? readNumstatThroughSettledCache(
          worktreePath,
          false,
          hasUnstagedRenames,
          entries,
          configRead,
          options
        )
      : Promise.resolve(emptyStats),
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
        ? (stagedStats ?? emptyStats).get(entry.path)
        : area === 'unstaged'
          ? (unstagedStats ?? emptyStats).get(entry.path)
          : untrackedStats.get(entry.path)
    )
  }
  return stagedStats !== null && unstagedStats !== null
}
