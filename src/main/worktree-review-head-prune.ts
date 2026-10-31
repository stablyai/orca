import type { ExecutionHostId } from '../shared/execution-host'
import type { WorktreeMeta } from '../shared/worktree/meta-types'
import { removeWorktreeMetaRow } from './persistence/host-qualified-worktree-meta'
import { pruneReviewHeadLocalRefsAfterWorktreeDelete } from './git/review-head-ref-prune'

type ReviewHeadPruneStore = Parameters<typeof removeWorktreeMetaRow>[0] & {
  getAllWorktreeMeta: () => Record<string, WorktreeMeta>
}

/** Best-effort: drop durable refs/orca/** pins when the last linked worktree is gone (#10431). */
export async function maybePruneReviewHeadRefsAfterWorktreeDelete(params: {
  store: ReviewHeadPruneStore
  repoPath: string
  repoId: string
  worktreeId: string
  hostId?: ExecutionHostId
  meta: Pick<WorktreeMeta, 'linkedPR' | 'linkedGitLabMR'> | null | undefined
  localGitOptions?: { cwd?: string; wslDistro?: string }
}): Promise<void> {
  try {
    await pruneReviewHeadLocalRefsAfterWorktreeDelete({
      repoPath: params.repoPath,
      repoId: params.repoId,
      deletedWorktreeId: params.worktreeId,
      meta: params.meta,
      // Drop the row under the prune lock, then re-read siblings. Transient cleanup still runs after.
      finalizeDeletedMetaAndReadSiblings: () => {
        removeWorktreeMetaRow(params.store, params.worktreeId, params.hostId)
        const remaining: Record<string, WorktreeMeta | undefined> = {
          ...params.store.getAllWorktreeMeta()
        }
        return remaining
      },
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
