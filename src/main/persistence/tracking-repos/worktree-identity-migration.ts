import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'

/**
 * Re-keys every worktreeId-keyed record in `state` from `oldWorktreeId` to `newWorktreeId`. Mutates `state` in place;
 * returns whether anything changed so the caller can gate its save. No-op when the ids match.
 * See `Store.migrateWorktreeIdentity` for why the rename happens.
 */
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
  const withNewWorktreeId = <T extends { worktreeId: string }>(value: T): T =>
    value.worktreeId === oldWorktreeId ? { ...value, worktreeId: newWorktreeId } : value
  const migrateSession = (session: WorkspaceSessionState | undefined): boolean => {
    if (!session) {
      return false
    }
    let sessionChanged = false
    const moveSessionKey = <T>(
      record: Record<string, T> | undefined,
      mapValue: (value: T) => T = (value) => value
    ): boolean => {
      if (!record) {
        return false
      }
      let moved = false
      const pairs: [string, string][] = [
        [oldWorktreeId, newWorktreeId],
        [oldWorkspaceKey, newWorkspaceKey]
      ]
      for (const [oldKey, newKey] of pairs) {
        if (!(oldKey in record)) {
          continue
        }
        record[newKey] = mapValue(record[oldKey])
        delete record[oldKey]
        moved = true
      }
      return moved
    }

    sessionChanged =
      moveSessionKey(session.tabsByWorktree, (tabs) => tabs.map(withNewWorktreeId)) ||
      sessionChanged
    sessionChanged =
      moveSessionKey(session.openFilesByWorktree, (files) => files.map(withNewWorktreeId)) ||
      sessionChanged
    sessionChanged = moveSessionKey(session.activeFileIdByWorktree) || sessionChanged
    sessionChanged =
      moveSessionKey(session.browserTabsByWorktree, (workspaces) =>
        workspaces.map(withNewWorktreeId)
      ) || sessionChanged
    if (session.browserPagesByWorkspace) {
      let pagesChanged = false
      const nextPagesByWorkspace = { ...session.browserPagesByWorkspace }
      for (const [workspaceId, pages] of Object.entries(nextPagesByWorkspace)) {
        if (!pages.some((page) => page.worktreeId === oldWorktreeId)) {
          continue
        }
        nextPagesByWorkspace[workspaceId] = pages.map(withNewWorktreeId)
        pagesChanged = true
      }
      if (pagesChanged) {
        session.browserPagesByWorkspace = nextPagesByWorkspace
        sessionChanged = true
      }
    }
    sessionChanged = moveSessionKey(session.activeBrowserTabIdByWorktree) || sessionChanged
    sessionChanged = moveSessionKey(session.activeTabTypeByWorktree) || sessionChanged
    sessionChanged = moveSessionKey(session.activeTabIdByWorktree) || sessionChanged
    sessionChanged =
      moveSessionKey(session.unifiedTabs, (tabs) => tabs.map(withNewWorktreeId)) || sessionChanged
    sessionChanged =
      moveSessionKey(session.tabGroups, (groups) => groups.map(withNewWorktreeId)) || sessionChanged
    sessionChanged = moveSessionKey(session.tabGroupLayouts) || sessionChanged
    sessionChanged = moveSessionKey(session.activeGroupIdByWorktree) || sessionChanged
    if (session.lastVisitedAtByWorktreeId) {
      const nextRecency = { ...session.lastVisitedAtByWorktreeId }
      let recencyChanged = false
      for (const [key, value] of Object.entries(session.lastVisitedAtByWorktreeId)) {
        const rawId = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
        if (rawId !== oldWorktreeId) {
          continue
        }
        const nextKey = isWorktreeHostIdentity(key)
          ? `${key.slice(0, key.length - rawId.length)}${newWorktreeId}`
          : newWorktreeId
        // Why max: a partial migration leaves both identities behind; taking the older one would
        // regress Cmd+J recency after restart.
        const existing = nextRecency[nextKey]
        nextRecency[nextKey] = existing === undefined ? value : Math.max(existing, value)
        delete nextRecency[key]
        recencyChanged = true
      }
      if (recencyChanged) {
        session.lastVisitedAtByWorktreeId = nextRecency
        sessionChanged = true
      }
    }
    sessionChanged =
      moveSessionKey(session.defaultTerminalTabsAppliedByWorktreeId) || sessionChanged
    if (session.activeWorktreeIdsOnShutdown?.includes(oldWorktreeId)) {
      session.activeWorktreeIdsOnShutdown = session.activeWorktreeIdsOnShutdown.map((id) =>
        id === oldWorktreeId ? newWorktreeId : id
      )
      sessionChanged = true
    }
    if (session.activeWorktreeId === oldWorktreeId) {
      session.activeWorktreeId = newWorktreeId
      sessionChanged = true
    }
    if (session.activeWorkspaceKey === oldWorkspaceKey) {
      session.activeWorkspaceKey = newWorkspaceKey
      sessionChanged = true
    }
    if (session.sleepingAgentSessionsByPaneKey) {
      let sleepingChanged = false
      const nextSleeping = { ...session.sleepingAgentSessionsByPaneKey }
      for (const [paneKey, record] of Object.entries(nextSleeping)) {
        if (record.worktreeId !== oldWorktreeId) {
          continue
        }
        nextSleeping[paneKey] = { ...record, worktreeId: newWorktreeId }
        sleepingChanged = true
      }
      if (sleepingChanged) {
        session.sleepingAgentSessionsByPaneKey = nextSleeping
        sessionChanged = true
      }
    }
    if (session.terminalSurfaceTombstonesByPaneKey) {
      let tombstonesChanged = false
      const nextTombstones = { ...session.terminalSurfaceTombstonesByPaneKey }
      for (const [paneKey, tombstone] of Object.entries(nextTombstones)) {
        if (tombstone.worktreeId !== oldWorktreeId) {
          continue
        }
        nextTombstones[paneKey] = { ...tombstone, worktreeId: newWorktreeId }
        tombstonesChanged = true
      }
      if (tombstonesChanged) {
        session.terminalSurfaceTombstonesByPaneKey = nextTombstones
        sessionChanged = true
      }
    }
    return sessionChanged
  }

  let changed = moveKey(state.worktreeMeta)
  // Record the prior id so a session minted under it isn't reaped as an orphan.
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
    // Why: moveKey reports nothing when the record already sat under the new key, so flag the repair
    // ourselves or the caller skips the save and the stale id comes back on reload.
    changed = true
  }
  // Why: children carry this as parentWorktreeId; keep the denormalized path-derived id consistent (parentWorktreeInstanceId is stable).
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

  changed = migrateSession(state.workspaceSession) || changed
  for (const session of Object.values(state.workspaceSessionsByHostId ?? {})) {
    changed = migrateSession(session) || changed
  }
  for (const selectionsByWorktree of Object.values(
    state.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    changed = moveKey(selectionsByWorktree) || changed
  }
  const showDotfiles = state.ui?.showDotfilesByWorktree
  if (showDotfiles) {
    changed = moveKey(showDotfiles) || changed
  }

  return changed
}
