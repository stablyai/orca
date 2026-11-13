import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
import { mergeWorktree } from '../../../ipc/worktree-metadata-merge'
import { readWorktreeMetaForHost } from '../../../persistence/host-qualified-worktree-meta'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'

/** One place's row from its own host's records, by key: the repo registered on that host and
 *  that host's metadata. Null when no repo is registered there. */
export function resolvedWorktreeForHost(
  store: RuntimeStore,
  worktreeId: string,
  hostId: ExecutionHostId
): ResolvedWorktree | null {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repo = parsed?.repoId ? store.getRepoForHost?.(parsed.repoId, hostId) : undefined
  return repo
    ? resolvedWorktreeRow(
        worktreeId,
        hostId,
        repo,
        readWorktreeMetaForHost(store, worktreeId, hostId)
      )
    : null
}

/** A worktree row from its id, owner host, repo and metadata, with no git listing: names follow
 *  `mergeWorktree`, so pinned and automatic labels read as they do in a catalog row. */
export function resolvedWorktreeRow(
  worktreeId: string,
  hostId: ExecutionHostId,
  repo: Repo | null | undefined,
  meta: WorktreeMeta | undefined
): ResolvedWorktree | null {
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    return null
  }
  const git = {
    path: parsed.worktreePath,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: repo ? areWorktreePathsEqual(parsed.worktreePath, repo.path) : false
  }
  const merged = { ...mergeWorktree(parsed.repoId, git, meta, repo?.displayName), hostId }
  return {
    ...merged,
    id: worktreeId,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    git,
    displayName: merged.displayName,
    comment: merged.comment
  }
}
