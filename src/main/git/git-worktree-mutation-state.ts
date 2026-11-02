import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { classifyGitCommand, findGitSubcommandIndex } from '../../shared/git-command-classification'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { resolveWorktreeHostPath } from '../../shared/git-metadata-path'
import { resolveGitFetchHeadCommand } from '../../shared/git-fetch-head-lock'
import { resolveGitDir } from './source-control/resolve-git-dir'
import type { GitRuntimeOptions } from './git-runtime-options'

// These can write refs or objects without changing HEAD, the index, or the working tree.
const WORKTREE_NEUTRAL_SUBCOMMANDS = new Set(['fetch', 'push', 'ls-remote', 'merge-tree'])

const pending = new Set<{ path: string; gitDir?: string; wslDistro?: string }>()

export function trackGitWorktreeMutation(
  args: readonly string[],
  options: GitRuntimeOptions & { cwd: string }
): () => void {
  if (
    classifyGitCommand(args) === 'read' ||
    WORKTREE_NEUTRAL_SUBCOMMANDS.has(args[findGitSubcommandIndex(args)] ?? '')
  ) {
    return () => {}
  }
  const command = resolveGitFetchHeadCommand(args, options.cwd)
  const entry = { path: command.cwd, gitDir: command.gitDir, wslDistro: options.wslDistro }
  pending.add(entry)
  return () => pending.delete(entry)
}

/** Covers commands from every client of this host, including ones still queued for admission. */
export async function isGitWorktreeMutationInFlight(
  worktreePath: string,
  options: GitRuntimeOptions
): Promise<boolean> {
  const candidates = [...pending].filter((entry) => entry.wslDistro === options.wslDistro)
  if (candidates.length === 0) {
    return false
  }
  const canonical = async (value: string): Promise<string> => {
    const hostPath = resolveWorktreeHostPath(value, options) ?? value
    return normalizeRuntimePathForComparison(
      await realpath(hostPath).catch(() => resolve(hostPath))
    )
  }
  const target = await canonical(worktreePath)
  const targetGitDir = await resolveGitDir(worktreePath, options).then(canonical, () => null)
  const matches = await Promise.all(
    candidates.map(
      async (entry) =>
        (await canonical(entry.path)) === target ||
        (targetGitDir !== null &&
          entry.gitDir !== undefined &&
          (await canonical(entry.gitDir)) === targetGitDir)
    )
  )
  return candidates.some((entry, index) => pending.has(entry) && matches[index])
}
