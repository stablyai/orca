import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorkspaceMetadataCursor } from '../../../../shared/worktree/workspace-metadata-set'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { getRepoOwnedWorktreeMeta } from '../../../workspaces/catalog/worktree-metadata-ownership'

/**
 * The metadata a listing reads, with the store's workspaceMetadata cursor taken in the same turn, so
 * clients can tell which published metadata records the listing includes.
 */
export function readRuntimeListingMetadata(
  store: RuntimeStore,
  repo: Repo
): {
  repoOwnerCount: number
  workspaceMetadata: WorkspaceMetadataCursor | undefined
  // The repo-owned metadata row for a worktree id, from this same read.
  ownedMeta: (worktreeId: string) => WorktreeMeta | undefined
} {
  const workspaceMetadata = store.getWorkspaceMetadataCursor?.()
  const metaById = store.getAllWorktreeMeta()
  const repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
  return {
    repoOwnerCount,
    workspaceMetadata,
    ownedMeta: (worktreeId) => getRepoOwnedWorktreeMeta(repo, worktreeId, metaById, repoOwnerCount)
  }
}
