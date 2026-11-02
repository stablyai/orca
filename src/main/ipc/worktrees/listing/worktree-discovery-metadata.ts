import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getProjectHostSetupWorktreeMeta } from '../../../../shared/project-host-setup-lookup'
import {
  hostWorktreeTargetForRepo,
  readWorktreeMetaForRepo
} from '../../../persistence/host-qualified-worktree-meta'
import { getRepoOwnedWorktreeMeta } from '../../../worktree-metadata-ownership'
import { randomUUID } from 'node:crypto'

export function getProjectHostSetupMetaUpdates(
  store: Store,
  repo: Repo,
  existing?: WorktreeMeta
): Partial<Pick<WorktreeMeta, 'projectId' | 'hostId' | 'projectHostSetupId'>> {
  const ownership = getProjectHostSetupWorktreeMeta(store.getProjectHostSetups(), repo)
  const sameSetup =
    existing?.projectHostSetupId === undefined ||
    existing.projectHostSetupId === ownership.projectHostSetupId
  return {
    // Repair legacy project identity only when host setup still matches.
    ...(sameSetup && existing?.projectId !== ownership.projectId
      ? { projectId: ownership.projectId }
      : {}),
    ...(sameSetup && existing?.hostId === undefined ? { hostId: ownership.hostId } : {}),
    ...(existing?.projectHostSetupId === undefined
      ? { projectHostSetupId: ownership.projectHostSetupId }
      : {})
  }
}

// First-discovered worktrees need activity timestamps to avoid sinking to the bottom of Recent.
export function resolveWorktreeMetaWithDiscoveryBackfill(
  store: Store,
  repo: Repo,
  worktreeId: string,
  allMetaOverride?: Record<string, WorktreeMeta>,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): WorktreeMeta {
  const target = hostWorktreeTargetForRepo(worktreeId, repo)
  const allMeta = allMetaOverride ?? store.getAllWorktreeMeta?.()
  // Use locator-keyed metadata only when no snapshot is available.
  const legacyMeta = allMeta === undefined ? store.getWorktreeMeta?.(worktreeId) : undefined
  const existing =
    readWorktreeMetaForRepo(store, worktreeId, repo) ??
    getRepoOwnedWorktreeMeta(
      repo,
      worktreeId,
      allMeta ?? (legacyMeta ? { [worktreeId]: legacyMeta } : {}),
      repoOwnerCount
    )
  const ownershipUpdates = getProjectHostSetupMetaUpdates(store, repo, existing)
  if (existing) {
    const updates = {
      ...(!existing.instanceId ? { instanceId: randomUUID() } : {}),
      ...ownershipUpdates
    }
    if (Object.keys(updates).length > 0) {
      // Discovery backfills lineage and routing for profiles whose metadata predates them.
      return store.setWorktreeMeta(target, updates)
    }
    return existing
  }
  return store.setWorktreeMeta(target, {
    lastActivityAt: Date.now(),
    ...ownershipUpdates
  })
}
