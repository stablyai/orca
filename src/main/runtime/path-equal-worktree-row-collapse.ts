import { LOCAL_EXECUTION_HOST_ID, getRepoExecutionHostId } from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { worktreePathComparisonKey } from '../ipc/worktree-path-comparison'

export type PathEqualWorktreeRowCollapseOptions = {
  /** The repo's own spelling of its root; the preferred survivor so `<repoId>::<path>` ids stay stable. */
  repoPath: string
  /** True when a spelling already owns persisted worktree metadata. */
  hasStoredMeta?: (worktreePath: string) => boolean
  /** Platform of the host that produced the rows — not necessarily the desktop's. */
  platform?: NodeJS.Platform
}

/**
 * Which platform's path rules apply to a repo's scanned rows.
 *
 * Why: rows can come from an SSH or runtime host, and applying the desktop's macOS `/private/tmp`
 * firmlink remap to a remote host would collapse two directories that are genuinely distinct there.
 */
export function resolveRepoWorktreePathPlatform(repo: Repo): NodeJS.Platform {
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID ? process.platform : 'linux'
}

/**
 * Collapse rows naming the same directory under different spellings (`.` or `..` segments, repeated
 * or trailing separators, Windows slash style and drive-letter case) into a single row, in place, so
 * Git's own ordering survives — downstream `slice(0, limit)` and `candidates[0]` callers depend on it.
 *
 * The survivor keeps the canonical spelling (the repo's own path, else a spelling that already has
 * metadata, else Git's first row) so the derived worktree id stays stable, and adopts the branch,
 * head and flags of the peers it absorbs.
 *
 * Case-sensitive roots are never case-folded — POSIX paths (including on macOS, where APFS/HFSX can
 * be formatted case-sensitive) and the WSL UNC aliases Windows hosts report worktrees under.
 * Silently dropping a real worktree row is worse than showing a duplicate one.
 */
export function collapsePathEqualWorktreeRows(
  rows: readonly GitWorktreeInfo[],
  options: PathEqualWorktreeRowCollapseOptions
): GitWorktreeInfo[] {
  const platform = options.platform ?? process.platform
  const survivorIndexByPathKey = new Map<string, number>()
  const collapsed: GitWorktreeInfo[] = []
  for (const row of rows) {
    const pathKey = worktreePathComparisonKey(row.path, platform)
    const survivorIndex = survivorIndexByPathKey.get(pathKey)
    if (survivorIndex === undefined) {
      survivorIndexByPathKey.set(pathKey, collapsed.length)
      collapsed.push(row)
      continue
    }
    collapsed[survivorIndex] = mergePathEqualRows(collapsed[survivorIndex], row, options)
  }
  return collapsed
}

function mergePathEqualRows(
  survivor: GitWorktreeInfo,
  duplicate: GitWorktreeInfo,
  options: PathEqualWorktreeRowCollapseOptions
): GitWorktreeInfo {
  return {
    ...survivor,
    path: pickCanonicalSpelling(survivor.path, duplicate.path, options),
    // Why: the stored-metadata fallback row carries an empty head/branch, so a real Git row fills them.
    head: survivor.head || duplicate.head,
    branch: survivor.branch || duplicate.branch,
    isMainWorktree: survivor.isMainWorktree || duplicate.isMainWorktree,
    ...(survivor.isSparse || duplicate.isSparse ? { isSparse: true } : {})
  }
}

function pickCanonicalSpelling(
  survivorPath: string,
  duplicatePath: string,
  options: PathEqualWorktreeRowCollapseOptions
): string {
  if (survivorPath === options.repoPath || duplicatePath === options.repoPath) {
    return options.repoPath
  }
  const { hasStoredMeta } = options
  if (!hasStoredMeta || hasStoredMeta(survivorPath) || !hasStoredMeta(duplicatePath)) {
    return survivorPath
  }
  return duplicatePath
}
