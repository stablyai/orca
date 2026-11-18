import {
  type WorkspaceKey,
  worktreeWorkspaceKey
} from '../../../shared/workspace/identity/workspace-scope'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { withCrossStoreChildKey } from '../../../shared/worktree/lineage/cross-store-lineage-records'
import { migrateWorkspaceSessionWorktreeIdentity } from './worktree-identity-session-migration'
import { replaceWorkspaceSessionPartitions } from '../restoring-sessions/workspace-session-partition-replacement'

/** Mutate worktree references in place (sessions are replaced); return whether anything changed so callers can gate persistence. */
export function migrateWorktreeIdentity(
  state: PersistedState,
  oldWorktreeId: string,
  newWorktreeId: string
): boolean {
  if (oldWorktreeId === newWorktreeId) {
    return false
  }
  const oldWorkspaceKey = worktreeWorkspaceKey(oldWorktreeId)
  const newWorkspaceKey = worktreeWorkspaceKey(newWorktreeId)
  const moveKey = <T>(
    record: Record<string, T>,
    mapValue: (value: T) => T = (value) => value
  ): boolean => {
    if (!(oldWorktreeId in record)) {
      return false
    }
    record[newWorktreeId] = mapValue(record[oldWorktreeId])
    delete record[oldWorktreeId]
    return true
  }
  let changed = moveKey(state.worktreeMeta)
  // Retain the prior ID so existing terminal sessions do not become orphans.
  const newMeta = state.worktreeMeta[newWorktreeId]
  if (newMeta) {
    const prior = newMeta.priorWorktreeIds ?? []
    if (!prior.includes(oldWorktreeId)) {
      newMeta.priorWorktreeIds = [...prior, oldWorktreeId]
      changed = true
    }
  }

  changed = moveKey(state.worktreeLineageById) || changed
  const movedLineage = state.worktreeLineageById[newWorktreeId]
  if (movedLineage && movedLineage.worktreeId === oldWorktreeId) {
    movedLineage.worktreeId = newWorktreeId
    // Repairing an already-rekeyed row still needs a save.
    changed = true
  }
  // Keep children's path-derived parent IDs consistent; parent instance identity stays stable.
  for (const lineage of Object.values(state.worktreeLineageById)) {
    if (lineage.parentWorktreeId === oldWorktreeId) {
      lineage.parentWorktreeId = newWorktreeId
      changed = true
    }
  }

  if (oldWorkspaceKey in state.workspaceLineageByChildKey) {
    const lineage = state.workspaceLineageByChildKey[oldWorkspaceKey]
    state.workspaceLineageByChildKey[newWorkspaceKey] = {
      ...lineage,
      childWorkspaceKey: newWorkspaceKey
    }
    delete state.workspaceLineageByChildKey[oldWorkspaceKey]
    changed = true
  }
  // Only the child moves; a cross-store parent names another store's workspace, never this one.
  if (state.crossStoreLineageByChildKey && oldWorkspaceKey in state.crossStoreLineageByChildKey) {
    state.crossStoreLineageByChildKey[newWorkspaceKey] = withCrossStoreChildKey(
      state.crossStoreLineageByChildKey[oldWorkspaceKey],
      newWorkspaceKey
    )
    delete state.crossStoreLineageByChildKey[oldWorkspaceKey]
    changed = true
  }
  for (const [childKey, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    if (lineage.parentWorkspaceKey === oldWorkspaceKey) {
      state.workspaceLineageByChildKey[childKey as WorkspaceKey] = {
        ...lineage,
        parentWorkspaceKey: newWorkspaceKey
      }
      changed = true
    }
  }

  // Publish replacements: rollback of an in-flight session write keeps the previous objects.
  const localSession =
    state.workspaceSession &&
    migrateWorkspaceSessionWorktreeIdentity(state.workspaceSession, oldWorktreeId, newWorktreeId)
  if (localSession) {
    state.workspaceSession = localSession
    changed = true
  }
  const partitions = replaceWorkspaceSessionPartitions(state.workspaceSessionsByHostId, (session) =>
    migrateWorkspaceSessionWorktreeIdentity(session, oldWorktreeId, newWorktreeId)
  )
  if (partitions !== state.workspaceSessionsByHostId) {
    state.workspaceSessionsByHostId = partitions
    changed = true
  }
  for (const selectionsByWorktree of Object.values(
    state.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    changed = moveKey(selectionsByWorktree) || changed
  }
  for (const bindings of [
    state.settings.codexWorkspaceAccounts,
    state.settings.claudeWorkspaceAccounts,
    state.ui?.explorerDisplayRootByWorktree,
    state.ui?.gitGraphFiltersByWorktree,
    state.ui?.showDotfilesByWorktree,
    state.ui?.notificationsMutedByWorktree
  ]) {
    if (bindings) {
      changed = moveKey<unknown>(bindings) || changed
    }
  }
  return changed
}
