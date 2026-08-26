import { randomUUID } from 'node:crypto'
import type { Repo } from '../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../shared/worktree/lineage-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { worktreeIdComparisonKey } from '../shared/worktree/id'
import { isWorkspaceKey, parseWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import type { Store } from './persistence'

function worktreeIdBelongsToRepo(worktreeId: string, repoPrefix: string): boolean {
  return worktreeId.startsWith(repoPrefix)
}

function workspaceKeyBelongsToRepo(workspaceKey: string, repoPrefix: string): boolean {
  const scope = parseWorkspaceKey(workspaceKey)
  return scope?.type === 'worktree' && worktreeIdBelongsToRepo(scope.worktreeId, repoPrefix)
}

function hasStoredRepoLineage(
  repoPrefix: string,
  worktreeLineage: Readonly<Record<string, WorktreeLineage>>,
  workspaceLineage: Readonly<Record<string, WorkspaceLineage>>
): boolean {
  return (
    Object.entries(worktreeLineage).some(
      ([childId, lineage]) =>
        worktreeIdBelongsToRepo(childId, repoPrefix) ||
        worktreeIdBelongsToRepo(lineage.parentWorktreeId, repoPrefix)
    ) ||
    Object.values(workspaceLineage).some(
      (lineage) =>
        workspaceKeyBelongsToRepo(lineage.childWorkspaceKey, repoPrefix) ||
        workspaceKeyBelongsToRepo(lineage.parentWorkspaceKey, repoPrefix)
    )
  )
}

export function pruneLineageForMissingRepoWorktrees(
  store: Store,
  repo: Repo,
  gitWorktrees: GitWorktreeInfo[]
): void {
  if (
    typeof store.getAllWorktreeLineage !== 'function' ||
    typeof store.removeWorktreeLineage !== 'function'
  ) {
    return
  }
  const worktreeLineage = store.getAllWorktreeLineage()
  const workspaceLineage = store.getAllWorkspaceLineage?.() ?? {}
  const repoPrefix = `${repo.id}::`
  // Why: one empty observation cannot prove every registered lineage edge disappeared at once.
  if (
    gitWorktrees.length === 0 &&
    hasStoredRepoLineage(repoPrefix, worktreeLineage, workspaceLineage)
  ) {
    return
  }
  const liveIds = new Set(gitWorktrees.map((worktree) => `${repo.id}::${worktree.path}`))
  // Why (#15598): git reports Windows paths with forward slashes while stored
  // lineage keys can carry backslashes; exact-only membership would prune the
  // lineage (and rotate the parent's instance) of a checkout that never went
  // anywhere. An id is live when either spelling matches.
  const liveComparisonKeys = new Set(
    [...liveIds]
      .map((id) => worktreeIdComparisonKey(id))
      .filter((key): key is string => key !== null)
  )
  const isLiveWorktreeId = (worktreeId: string): boolean =>
    liveIds.has(worktreeId) ||
    liveComparisonKeys.has(worktreeIdComparisonKey(worktreeId) ?? worktreeId)
  const expectedHostId = getRepoExecutionHostId(repo)
  const repoOwners = store.getRepos().filter((candidate) => candidate.id === repo.id)
  const canMutateWorktree = (worktreeId: string): boolean => {
    const hostId = store.getWorktreeMeta(worktreeId)?.hostId
    return hostId ? hostId === expectedHostId : repoOwners.length === 1
  }
  for (const childWorkspaceKey of Object.keys(workspaceLineage)) {
    const childScope = parseWorkspaceKey(childWorkspaceKey)
    if (
      childScope?.type === 'worktree' &&
      worktreeIdBelongsToRepo(childScope.worktreeId, repoPrefix) &&
      canMutateWorktree(childScope.worktreeId) &&
      !isLiveWorktreeId(childScope.worktreeId) &&
      isWorkspaceKey(childWorkspaceKey)
    ) {
      store.removeWorkspaceLineage?.(childWorkspaceKey)
    }
  }
  for (const [childId, lineage] of Object.entries(worktreeLineage)) {
    if (
      worktreeIdBelongsToRepo(childId, repoPrefix) &&
      canMutateWorktree(childId) &&
      !isLiveWorktreeId(childId)
    ) {
      // Why: a proven-missing path must not transfer its lineage to a future checkout at that path.
      store.removeWorktreeLineage(childId)
      store.removeWorkspaceLineage?.(worktreeWorkspaceKey(childId))
    }
    if (
      worktreeIdBelongsToRepo(lineage.parentWorktreeId, repoPrefix) &&
      canMutateWorktree(lineage.parentWorktreeId) &&
      !isLiveWorktreeId(lineage.parentWorktreeId)
    ) {
      const parentMeta = store.getWorktreeMeta(lineage.parentWorktreeId)
      if (!parentMeta || parentMeta.instanceId === lineage.parentWorktreeInstanceId) {
        // Why: rotate a proven-missing parent's identity once so path reuse cannot validate old lineage.
        store.setWorktreeMeta(lineage.parentWorktreeId, { instanceId: randomUUID() })
      }
    }
  }
}
