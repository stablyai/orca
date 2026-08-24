import { randomUUID } from 'node:crypto'
import type { Repo } from '../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../shared/worktree/lineage-types'
import type { GitWorktreeInfo } from '../shared/worktree/types'
import { getRepoExecutionHostId } from '../shared/execution-host'
import { isWorkspaceKey, parseWorkspaceKey, worktreeWorkspaceKey } from '../shared/workspace-scope'
import { splitWorktreeId } from '../shared/worktree/id'
import { worktreePathComparisonKey } from './ipc/worktree-path-comparison'
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
  gitWorktrees: GitWorktreeInfo[],
  // Why required: rows can come from an SSH or WSL host, and silently defaulting to the desktop's
  // rules would apply macOS `/private/tmp` remapping to a remote host's paths.
  platform: NodeJS.Platform
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
  const livePathKeys = new Set(
    gitWorktrees.map((worktree) => worktreePathComparisonKey(worktree.path, platform))
  )
  // Why: lineage is keyed on a stored spelling, so a live worktree reported under another spelling of
  // the same directory must never look "proven missing" — that deletion is irreversible.
  const isLive = (worktreeId: string): boolean => {
    if (liveIds.has(worktreeId)) {
      return true
    }
    // Why not `...ForFilesystem`: folder-workspace instances legitimately share a directory, so their
    // id suffix must keep them distinct here.
    const worktreePath = splitWorktreeId(worktreeId)?.worktreePath
    return worktreePath
      ? livePathKeys.has(worktreePathComparisonKey(worktreePath, platform))
      : false
  }
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
      !isLive(childScope.worktreeId) &&
      isWorkspaceKey(childWorkspaceKey)
    ) {
      store.removeWorkspaceLineage?.(childWorkspaceKey)
    }
  }
  for (const [childId, lineage] of Object.entries(worktreeLineage)) {
    if (
      worktreeIdBelongsToRepo(childId, repoPrefix) &&
      canMutateWorktree(childId) &&
      !isLive(childId)
    ) {
      // Why: a proven-missing path must not transfer its lineage to a future checkout at that path.
      store.removeWorktreeLineage(childId)
      store.removeWorkspaceLineage?.(worktreeWorkspaceKey(childId))
    }
    if (
      worktreeIdBelongsToRepo(lineage.parentWorktreeId, repoPrefix) &&
      canMutateWorktree(lineage.parentWorktreeId) &&
      !isLive(lineage.parentWorktreeId)
    ) {
      const parentMeta = store.getWorktreeMeta(lineage.parentWorktreeId)
      if (!parentMeta || parentMeta.instanceId === lineage.parentWorktreeInstanceId) {
        // Why: rotate a proven-missing parent's identity once so path reuse cannot validate old lineage.
        store.setWorktreeMeta(lineage.parentWorktreeId, { instanceId: randomUUID() })
      }
    }
  }
}
