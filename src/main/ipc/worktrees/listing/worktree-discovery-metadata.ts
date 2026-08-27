import type { Store } from '../../../persistence/loading-store/store'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { getProjectHostSetupWorktreeMeta } from '../../../../shared/project-host-setup-lookup'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  readWorktreeMetaForHost,
  writeWorktreeMetaForHost
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
    // Why: project IDs can upgrade from legacy repo IDs to provider-backed ones; repair ownership on discovery when the host setup matches.
    ...(sameSetup && existing?.projectId !== ownership.projectId
      ? { projectId: ownership.projectId }
      : {}),
    ...(sameSetup && existing?.hostId === undefined ? { hostId: ownership.hostId } : {}),
    ...(existing?.projectHostSetupId === undefined
      ? { projectHostSetupId: ownership.projectHostSetupId }
      : {})
  }
}

// Why: disk-discovered worktrees have no WorktreeMeta, so lastActivityAt=0 sinks them to the bottom of "Recent"; also backfill host-setup ownership here.
export function resolveWorktreeMetaWithDiscoveryBackfill(
  store: Store,
  repo: Repo,
  worktreeId: string,
  allMetaOverride?: Record<string, WorktreeMeta>,
  repoOwnerCount = store.getRepos().filter((candidate) => candidate.id === repo.id).length
): WorktreeMeta {
  const executionHostId = getRepoExecutionHostId(repo)
  const legacyMeta = store.getWorktreeMeta?.(worktreeId)
  const allMeta = allMetaOverride ?? store.getAllWorktreeMeta?.()
  const existing =
    readWorktreeMetaForHost(store, worktreeId, executionHostId) ??
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
      // Why: pre-lineage profiles already have WorktreeMeta rows; backfill on discovery so upgraded workspaces get lineage and host routing.
      return writeWorktreeMetaForHost(store, worktreeId, executionHostId, updates)
    }
    return existing
  }
  return writeWorktreeMetaForHost(store, worktreeId, executionHostId, {
    lastActivityAt: Date.now(),
    ...ownershipUpdates
  })
}
