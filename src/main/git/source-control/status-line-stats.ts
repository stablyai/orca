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
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'
import { settledNumstatCache } from './git-read-cache-invalidation'
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

// Statting more working files than this costs about as much as the numstat it would skip.
const MAX_STAMPED_UNSTAGED_PATHS = 256

/** Unstaged numstat stamps each listed working file; unlisted files are unchanged or status would list them. */
function unstagedStampPaths(entries: readonly GitStatusEntry[]): string[] | null {
  const paths: string[] = []
  for (const entry of entries) {
    if (entry.area !== 'unstaged') {
      continue
    }
    // A gitlink's numstat follows the submodule's HEAD, which no parent file stamps.
    if (entry.submodule) {
      return null
    }
    paths.push(entry.path)
    if (entry.oldPath !== undefined) {
      paths.push(entry.oldPath)
    }
  }
  return paths.length <= MAX_STAMPED_UNSTAGED_PATHS ? paths : null
}

/** Reuse a numstat pass while HEAD, index and the stamped working files are provably unchanged. */
async function readNumstatThroughSettledCache(
  worktreePath: string,
  cached: boolean,
  detectRenames: boolean,
  entries: readonly GitStatusEntry[],
  options: GitRuntimeOptions
): Promise<Map<string, GitLineStats> | null> {
  const stampPaths = cached ? [] : unstagedStampPaths(entries)
  if (!stampPaths) {
    return runNumstat(worktreePath, cached, detectRenames, options)
  }
  const readGeneration = settledNumstatCache.beginRead()
  const stamp = await readWorktreePathsDiffStamp(worktreePath, stampPaths, options)
  const readKey = JSON.stringify([worktreePath, options.wslDistro ?? '', cached, detectRenames])
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
  // Approximates status's rename policy: -M only for areas where status reported a rename.
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged
      ? readNumstatThroughSettledCache(worktreePath, true, hasStagedRenames, entries, options)
      : Promise.resolve(emptyStats),
    hasUnstaged
      ? readNumstatThroughSettledCache(worktreePath, false, hasUnstagedRenames, entries, options)
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
