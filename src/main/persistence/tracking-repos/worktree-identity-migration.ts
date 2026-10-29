import { LOCAL_EXECUTION_HOST_ID, normalizeExecutionHostId } from '../../../shared/execution-host'
import { runSessionOperation } from '../loading-store/session-operation'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'

/** Mutate worktree references in place; return whether anything changed so callers can gate persistence. */
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
  for (const [childKey, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    if (lineage.parentWorkspaceKey === oldWorkspaceKey) {
      state.workspaceLineageByChildKey[childKey as WorkspaceKey] = {
        ...lineage,
        parentWorkspaceKey: newWorkspaceKey
      }
      changed = true
    }
  }

  for (const host of [
    LOCAL_EXECUTION_HOST_ID,
    ...Object.keys(state.workspaceSessionsByHostId ?? {})
  ]) {
    const hostId = normalizeExecutionHostId(host)
    if (!hostId) {
      continue
    }
    const edit = runSessionOperation(state, hostId, {
      type: 'moveOwner',
      oldId: oldWorktreeId,
      newId: newWorktreeId
    })
    changed = edit.touchedFields().length > 0 || changed
  }
  for (const selectionsByWorktree of Object.values(
    state.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    changed = moveKey(selectionsByWorktree) || changed
  }
  if (state.ui?.explorerDisplayRootByWorktree) {
    changed = moveKey(state.ui.explorerDisplayRootByWorktree) || changed
  }
  const showDotfiles = state.ui?.showDotfilesByWorktree
  if (showDotfiles) {
    changed = moveKey(showDotfiles) || changed
  }

  return changed
}
