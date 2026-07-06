import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { checkIgnoredPaths } from '../git/check-ignored-paths'
import type { GitRuntimeOptions } from '../git/git-runtime-options'
import { gitOptionsForWorktree } from '../git/git-runtime-options'
import { gitExecFileAsync } from '../git/runner'

const WORKTREE_INCLUDE_FILENAME = '.worktreeinclude'

/** Drop any path nested under a directory entry (trailing `/`) already in the
 *  set: the parent link covers it, so a child entry is redundant. Keeps
 *  ls-files' sorted order (parents precede children). */
function collapseDescendants(paths: string[]): string[] {
  const dirs = paths.filter((path) => path.endsWith('/'))
  return paths.filter((path) => !dirs.some((dir) => dir !== path && path.startsWith(dir)))
}

/** Resolve the gitignored paths a repo's project-root `.worktreeinclude` selects
 *  for linking into new worktrees. Uses `.gitignore` syntax parsed by git via
 *  `--exclude-from` (globs, negation, comments — no hand-rolled matcher).
 *
 *  Why two git passes: Claude Code's contract copies only paths that match a
 *  pattern AND are already gitignored, so `ls-files` (pattern match, with
 *  `--directory` collapsing a whole dir like `node_modules` to one entry) is
 *  intersected with `check-ignore` against the real `.gitignore` (drops
 *  non-ignored matches and over-collapsed parents). Returns repo-relative paths
 *  for `createWorktreeLinkedPaths`; any git failure degrades to an empty list. */
export async function resolveWorktreeIncludePaths(
  repoPath: string,
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const includeFile = join(repoPath, WORKTREE_INCLUDE_FILENAME)
  try {
    // Why: `git ls-files --exclude-from` is fatal on a missing file, so gate on
    // existence first — the common case (no `.worktreeinclude`) costs one stat.
    await access(includeFile)
  } catch {
    return []
  }
  try {
    const { stdout } = await gitExecFileAsync(
      ['ls-files', '--others', '--ignored', '--directory', `--exclude-from=${includeFile}`],
      gitOptionsForWorktree(repoPath, options)
    )
    const candidates = stdout.split(/\r?\n/).filter(Boolean)
    if (candidates.length === 0) {
      return []
    }
    const ignored = new Set(await checkIgnoredPaths(repoPath, candidates, options))
    return collapseDescendants(candidates.filter((path) => ignored.has(path)))
  } catch (error) {
    console.warn(`[worktree-include] Failed to resolve ${includeFile}:`, error)
    return []
  }
}

/** Union of a repo's per-user `symlinkPaths` with the version-controlled paths
 *  its `.worktreeinclude` selects, deduped. This merged list is what gets
 *  linked into a new worktree and cleaned from it on delete. */
export async function resolveWorktreeLinkedPaths(
  repoPath: string,
  symlinkPaths: readonly string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const includePaths = await resolveWorktreeIncludePaths(repoPath, options)
  return Array.from(new Set([...symlinkPaths, ...includePaths]))
}
