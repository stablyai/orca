import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { pruneReviewHeadLocalRefsAfterWorktreeDelete } from './git/review-head-ref-prune'

type WorktreeMetaById = Record<string, WorktreeMeta | undefined>

/** Best-effort: drop durable refs/orca/** pins when the last linked worktree is gone (#10431). */
export async function maybePruneReviewHeadRefsAfterWorktreeDelete(params: {
  store: { getAllWorktreeMeta: () => Record<string, WorktreeMeta> }
  repoPath: string
  repoId: string
  worktreeId: string
  meta: Pick<WorktreeMeta, 'linkedPR' | 'linkedGitLabMR'> | null | undefined
  localGitOptions?: { cwd?: string; wslDistro?: string }
}): Promise<void> {
  try {
    // Snapshot before metadata removal. Sibling detection excludes the deleted id.
    const worktreeMetaById: WorktreeMetaById = { ...params.store.getAllWorktreeMeta() }
    await pruneReviewHeadLocalRefsAfterWorktreeDelete({
      repoPath: params.repoPath,
      repoId: params.repoId,
      deletedWorktreeId: params.worktreeId,
      meta: params.meta,
      worktreeMetaById,
      localGitOptions: {
        ...params.localGitOptions,
        cwd: params.repoPath
      }
    })
  } catch (error) {
    console.warn(
      `[worktrees] Failed to prune durable review-head refs after deleting ${params.worktreeId}:`,
      error
    )
  }
}
