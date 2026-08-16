import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { StoreOwnedPersistedState } from '../loading-store/store-owned-state'
import { removeWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'

export function pruneWorktreeStateForRepo(
  state: StoreOwnedPersistedState,
  id: string,
  hostId: ExecutionHostId | null,
  pruneMobileClientTabSelections: (matchesWorktreeId: (worktreeId: string) => boolean) => void
): void {
  const prefix = `${id}::`
  // Why snapshot up front: the first loop deletes metas, so reading meta.hostId live later would misclassify an SSH worktree as local.
  const hostMembership = new Map<string, boolean>()
  const belongsToHost = (key: string): boolean => {
    if (!key.startsWith(prefix)) {
      return false
    }
    if (hostId === null) {
      return true
    }
    const cached = hostMembership.get(key)
    if (cached !== undefined) {
      return cached
    }
    // Why default to local: metas without hostId predate host stamping, so a host-scoped prune skips them rather than risk deleting another host's live meta.
    const metaHostId = state.worktreeMeta[key]?.hostId ?? LOCAL_EXECUTION_HOST_ID
    const result = metaHostId === hostId
    hostMembership.set(key, result)
    return result
  }
  // Why: session state (legacy blob + per-host partitions) references worktrees
  // by the same `${repoId}::${path}` owner key; if it is not pruned here, a
  // deleted project's worktrees stay in lastVisitedAtByWorktreeId /
  // sleepingAgentSessionsByPaneKey and get re-materialized into worktreeMeta on
  // the next launch, surfacing as an orphaned "unknown" workspace.
  // worktreeMeta is host-classified via belongsToHost, but session partitions
  // are keyed by host directly. A session owner key carries no host, and the
  // same key can exist in multiple partitions (shared repo id/path across
  // hosts). So for session cleanup we collect every prefix-matching owner key
  // regardless of belongsToHost, and let the per-partition host gating below
  // decide which partition to touch. (belongsToHost still governs
  // worktreeMeta/lineage deletion. Collect before deleting worktreeMeta.)
  const ownerKeysToPrune = new Set<string>()
  const collectPrefixedKeys = (keys: Iterable<string>): void => {
    for (const key of keys) {
      if (key.startsWith(prefix)) {
        ownerKeysToPrune.add(key)
      }
    }
  }
  collectPrefixedKeys(Object.keys(state.worktreeMeta))
  collectPrefixedKeys(Object.keys(state.workspaceSession?.lastVisitedAtByWorktreeId ?? {}))
  for (const session of Object.values(state.workspaceSessionsByHostId ?? {})) {
    collectPrefixedKeys(Object.keys(session?.lastVisitedAtByWorktreeId ?? {}))
  }

  for (const key of Object.keys(state.worktreeMeta)) {
    if (belongsToHost(key)) {
      delete state.worktreeMeta[key]
    }
  }
  // Why: owner keys are `${repoId}::${path}` and do not carry a host, so a
  // host-scoped prune (hostId != null) must only touch that host's session:
  // the legacy blob is the local host's session, and each
  // workspaceSessionsByHostId partition is one non-local host. Pruning every
  // partition here would wipe a surviving host's tabs, sleeping-agent state,
  // and active-worktree pointer for a shared repo id/path. A full removal
  // (hostId === null) still clears every host.
  const pruneLegacyLocalSession = hostId === null || hostId === LOCAL_EXECUTION_HOST_ID
  const pruneAllHostPartitions = hostId === null
  if (pruneLegacyLocalSession) {
    state.workspaceSession = removeWorkspaceSessionOwners(state.workspaceSession, ownerKeysToPrune)!
  }
  if (state.workspaceSessionsByHostId) {
    for (const [partitionHostId, session] of Object.entries(state.workspaceSessionsByHostId)) {
      if (!pruneAllHostPartitions && partitionHostId !== hostId) {
        continue
      }
      const pruned = removeWorkspaceSessionOwners(session, ownerKeysToPrune)
      if (pruned) {
        state.workspaceSessionsByHostId[partitionHostId] = pruned
      }
    }
  }
  for (const [childId, lineage] of Object.entries(state.worktreeLineageById)) {
    if (belongsToHost(childId) || belongsToHost(lineage.parentWorktreeId)) {
      delete state.worktreeLineageById[childId]
    }
  }
  for (const [childKey, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    const childScope = parseWorkspaceKey(childKey)
    const parentScope = parseWorkspaceKey(lineage.parentWorkspaceKey)
    if (childScope?.type === 'worktree' && belongsToHost(childScope.worktreeId)) {
      delete state.workspaceLineageByChildKey[childKey as WorkspaceKey]
      continue
    }
    if (parentScope?.type === 'worktree' && belongsToHost(parentScope.worktreeId)) {
      delete state.workspaceLineageByChildKey[childKey as WorkspaceKey]
    }
  }
  pruneMobileClientTabSelections(belongsToHost)
}
