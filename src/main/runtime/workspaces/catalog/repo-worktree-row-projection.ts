import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { composeWorktreeId } from '../../../../shared/worktree/id'
import { readWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import { mergeWorktree } from '../../../ipc/worktree-metadata-merge'
import { getRepoOwnedWorktreeMeta } from '../../../workspaces/catalog/worktree-metadata-ownership'
import { projectCachedWorktreeRemovals } from '../../../workspaces/removal/worktree-removal-listing'
import type {
  RepoWorktreeRow,
  RepoWorktreeRowDeps,
  RepoWorktreeRowsScan
} from './repo-worktree-row-resolution'

/** The join half: a repo's rows from a scan and the metadata as it is now. Synchronous. */
export function projectRepoWorktreeRows(
  deps: Pick<RepoWorktreeRowDeps, 'store' | 'listFolderWorkspaces'>,
  repo: Repo,
  scan: RepoWorktreeRowsScan | null,
  metaById: Record<string, WorktreeMeta>,
  repoOwnerCount = deps.store.getRepos().filter((candidate) => candidate.id === repo.id).length
): RepoWorktreeRow[] {
  const { store } = deps
  if (isFolderRepo(repo)) {
    return deps.listFolderWorkspaces(repo, repoOwnerCount).map((worktree) => ({
      ...worktree,
      hostId: worktree.hostId ?? getRepoExecutionHostId(repo),
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: worktree.path,
        head: worktree.head,
        branch: worktree.branch,
        isBare: worktree.isBare,
        isMainWorktree: worktree.isMainWorktree
      },
      displayName: worktree.displayName,
      comment: worktree.comment
    }))
  }
  const expectedHostId = getRepoExecutionHostId(repo)
  const rows = (scan?.worktrees ?? []).map((gitWorktree) => {
    const worktreeId = composeWorktreeId(repo.id, gitWorktree.path)
    const meta =
      readWorktreeMetaForHost(store, worktreeId, expectedHostId) ??
      getRepoOwnedWorktreeMeta(repo, worktreeId, metaById, repoOwnerCount)
    const merged = {
      ...mergeWorktree(repo.id, gitWorktree, meta, repo.displayName),
      hostId: meta?.hostId ?? expectedHostId
    }
    return {
      ...merged,
      parentWorktreeId: null,
      childWorktreeIds: [],
      lineage: null,
      git: {
        path: gitWorktree.path,
        head: gitWorktree.head,
        branch: gitWorktree.branch,
        isBare: gitWorktree.isBare,
        isMainWorktree: gitWorktree.isMainWorktree,
        prunable: gitWorktree.prunable
      },
      displayName: merged.displayName,
      comment: merged.comment
    }
  })
  if (expectedHostId !== LOCAL_EXECUTION_HOST_ID || !scan) {
    return rows
  }
  return projectCachedWorktreeRemovals(repo.id, scan, rows, (row) => row.id)
}
