import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorkspaceMetadataCursor } from '../../../../shared/worktree/workspace-metadata-set'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/**
 * The metadata a listing reads, with the store's workspaceMetadata cursor taken in the same turn, so
 * clients can tell which published metadata records the listing includes.
 */
export function readRuntimeListingMetadata(
  store: RuntimeStore,
  repo: Repo
): {
  metaById: Record<string, WorktreeMeta>
  repoOwnerCount: number
  workspaceMetadata: WorkspaceMetadataCursor | undefined
} {
  return {
    workspaceMetadata: store.getWorkspaceMetadataCursor?.(),
    metaById: store.getAllWorktreeMeta(),
    repoOwnerCount: store.getRepos().filter((candidate) => candidate.id === repo.id).length
  }
}
