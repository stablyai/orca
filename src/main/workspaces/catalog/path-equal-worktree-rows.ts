import { composeWorktreeId } from '../../../shared/worktree/id'
import type { Repo } from '../../../shared/repository/repo-types'
import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import { dedupeWorktreesByPath } from '../../git/worktrees/catalog/worktree-path-comparison'

/** Git can register one checkout under several spellings; each would mint its own worktree id, so keep one row per directory. */
export function collapsePathEqualWorktreeRows(
  repo: Repo,
  worktrees: GitWorktreeInfo[],
  hasWorktreeMeta: (worktreeId: string) => boolean
): GitWorktreeInfo[] {
  // Keep the spelling Orca already keys metadata, lineage and `id:` selectors by; ties keep Git's order.
  const rank = (path: string): number =>
    (path === repo.path ? 2 : 0) + (hasWorktreeMeta(composeWorktreeId(repo.id, path)) ? 1 : 0)
  return dedupeWorktreesByPath(worktrees, process.platform, (kept, duplicate) => {
    const [row, peer] =
      rank(duplicate.path) > rank(kept.path) ? [duplicate, kept] : [kept, duplicate]
    return {
      ...row,
      // Each registration keeps its own HEAD; show the branch when only one of them is on one.
      ...(!row.branch && peer.branch ? { head: peer.head, branch: peer.branch } : {}),
      isMainWorktree: row.isMainWorktree || peer.isMainWorktree,
      ...(row.isSparse || peer.isSparse ? { isSparse: true } : {})
    }
  })
}
