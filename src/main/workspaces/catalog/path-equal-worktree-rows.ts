import { composeWorktreeId } from '../../../shared/worktree/id'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID
} from '../../../shared/execution-host/execution-host'
import type { Repo } from '../../../shared/repository/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { isWindowsAbsolutePathLike } from '../../../shared/file-access/cross-platform-path'
import {
  dedupeWorktreesByPath,
  looksLikePosixAbsolutePath
} from '../../git/worktrees/catalog/worktree-path-comparison'

// Observed scans are never mutated, so one that had no path-equal rows is returned as is on later reads.
const scansWithoutPathEqualRows = new WeakSet<readonly GitWorktreeInfo[]>()

/** Git can register one checkout under several spellings; each would mint its own worktree id, so keep one row per directory. */
export function collapsePathEqualWorktreeRows(
  repo: Repo,
  worktrees: GitWorktreeInfo[],
  hasWorktreeMeta: (worktreeId: string) => boolean
): GitWorktreeInfo[] {
  if (scansWithoutPathEqualRows.has(worktrees)) {
    return worktrees
  }
  // Never apply local macOS/Windows host rules to remote SSH repos whose OS path semantics are unknown.
  const platform: NodeJS.Platform =
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID ? process.platform : 'linux'
  // Keep the spelling Orca already keys metadata, lineage and `id:` selectors by; ties keep Git's order.
  const rank = (path: string): number =>
    (path === repo.path ? 2 : 0) + (hasWorktreeMeta(composeWorktreeId(repo.id, path)) ? 1 : 0)
  const collapsed = dedupeWorktreesByPath(worktrees, platform, (kept, duplicate) => {
    const [row, peer] =
      rank(duplicate.path) > rank(kept.path) ? [duplicate, kept] : [kept, duplicate]
    const base = row.prunable && !peer.prunable ? { ...peer, path: row.path } : row
    return {
      ...base,
      // Each registration keeps its own HEAD; show the branch when only one of them is on one.
      ...(!base.branch && peer.branch ? { head: peer.head, branch: peer.branch } : {}),
      isMainWorktree: row.isMainWorktree || peer.isMainWorktree,
      ...(row.isSparse || peer.isSparse ? { isSparse: true } : {})
    }
  })
  if (collapsed.length !== worktrees.length) {
    return collapsed
  }
  // Relative paths resolve against the cwd, so only absolute scans are remembered.
  if (
    worktrees.every(
      (worktree) =>
        looksLikePosixAbsolutePath(worktree.path) || isWindowsAbsolutePathLike(worktree.path)
    )
  ) {
    scansWithoutPathEqualRows.add(worktrees)
  }
  return worktrees
}
