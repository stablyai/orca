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
      {
        ...gitReadOptionsForWorktree(worktreePath, options),
        env: gitOptionalLocksDisabledEnv()
      }
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
    hasStaged ? runNumstat(worktreePath, true, options) : Promise.resolve(emptyStats),
    hasUnstaged ? runNumstat(worktreePath, false, options) : Promise.resolve(emptyStats),
    // Why: git took the guest path, but this read goes straight through Node's own namespace.
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
