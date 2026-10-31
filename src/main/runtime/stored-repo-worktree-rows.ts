import { knownWorktreeInventory, type WorktreeInventoryStore } from '../known-worktree-inventory'
import { splitWorktreeId } from '../../shared/worktree/id'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { Worktree } from '../../shared/worktree/types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeStore } from './runtime-store-contract'

/** Publish last-known persisted rows on unreachable/stalled scans, matching disconnected SSH listing behavior. */
export function listStoredWorktreeRowsForRepo(
  store: WorktreeInventoryStore & Pick<RuntimeStore, 'getRepos'>,
  repo: Repo,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): GitWorktreeInfo[] {
  const expectedHostId = getRepoExecutionHostId(repo)
  const byWorktreeId = new Map<string, GitWorktreeInfo>()
  for (const [worktreeId, meta] of Object.entries(knownWorktreeInventory(store).read(repo).meta)) {
    const parsed = splitWorktreeId(worktreeId)
    if (!parsed || parsed.repoId !== repo.id) {
      continue
    }
    // Same repo ids can belong to several hosts; degraded scans must not publish another owner's metadata.
    if (meta.hostId ? meta.hostId !== expectedHostId : repoOwnerCount > 1) {
      continue
    }
    byWorktreeId.set(worktreeId, {
      path: parsed.worktreePath,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: areWorktreePathsEqual(parsed.worktreePath, repo.path),
      ...(meta.sparseDirectories !== undefined ||
      meta.sparseBaseRef !== undefined ||
      meta.sparsePresetId !== undefined
        ? { isSparse: true }
        : {})
    })
  }
  return [...byWorktreeId.values()]
}

export function storedWorktreePresentation(
  meta: WorktreeMeta | undefined,
  merged: Worktree
): Pick<Worktree, 'displayName' | 'displayNameMode'> {
  return {
    displayName: meta?.displayName ?? merged.displayName,
    displayNameMode:
      meta?.displayNameIsPinned === undefined
        ? merged.displayNameMode
        : meta.displayNameIsPinned
          ? 'fixed'
          : 'automatic'
  }
}
