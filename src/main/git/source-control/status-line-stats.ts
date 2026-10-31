import type { GitStatusEntry } from '../../../shared/git-status-types'
import { collectGitStatusLineStatInputs } from '../../../shared/git-status-line-stat-inputs'
import {
  applyLineStats,
  collectUntrackedAdditions,
  parseNumstat,
  type GitLineStats
} from '../../../shared/git-uncommitted-line-stats'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitReadOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync, gitOptionalLocksDisabledEnv } from '../runner'
import { resolveWorktreeFilesystemPath } from './worktree-filesystem-path'

async function runNumstat(
  worktreePath: string,
  cached: boolean,
  entries: readonly GitStatusEntry[],
  options: GitRuntimeOptions = {}
): Promise<Map<string, GitLineStats> | null> {
  try {
    const area = cached ? 'staged' : 'unstaged'
    const detectCopies = entries.some((entry) => entry.area === area && entry.status === 'copied')
    const detectRenames = entries.some((entry) => entry.area === area && entry.status === 'renamed')
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
        detectCopies ? '-C' : detectRenames ? '-M' : '--no-renames'
      ],
      {
        ...gitReadOptionsForWorktree(worktreePath, options),
        env: gitOptionalLocksDisabledEnv()
      }
    )
    const expectedSources = new Map(
      entries
        .filter(
          (entry) =>
            entry.area === area && (entry.status === 'copied' || entry.status === 'renamed')
        )
        .map((entry) => [entry.path, entry.oldPath])
    )
    let compatible = true
    const stats = parseNumstat(stdout, (source, destination) => {
      // Stat-dirty unchanged files can be copy sources for diff but not status.
      if (detectCopies && expectedSources.get(destination) !== source) {
        compatible = false
      }
    })
    return compatible ? stats : null
  } catch (error) {
    // Propagate cancellation; ordinary numstat failures may degrade to uncounted rows.
    if (options.signal?.aborted) {
      throw error
    }
    // null marks the pass incomplete and uncacheable; an empty map would imply success.
    return null
  }
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
  const { hasStaged, hasUnstaged, untrackedPaths } = collectGitStatusLineStatInputs(entries)
  const emptyStats = new Map<string, GitLineStats>()
  const [stagedStats, unstagedStats, untrackedStats] = await Promise.all([
    hasStaged ? runNumstat(worktreePath, true, entries, options) : Promise.resolve(emptyStats),
    hasUnstaged ? runNumstat(worktreePath, false, entries, options) : Promise.resolve(emptyStats),
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
