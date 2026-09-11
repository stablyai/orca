import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { BrowserPage, BrowserWorkspace } from '../../../shared/browser-workspace-types'
import { remapBrowserPageDocLocation } from '../../../shared/browser-page-doc-location'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'

/** Session maps whose value names the worktree it belongs to, keyed by something else. */
const WORKTREE_ROW_RECORD_SESSION_FIELDS = [
  'sleepingAgentSessionsByPaneKey',
  'terminalSurfaceTombstonesByPaneKey',
  'closedTerminalTabTombstonesByTabId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

/** Same, but each value is an array of such rows. */
const WORKTREE_ROW_ARRAY_SESSION_FIELDS = [
  'clientHostedBrowserCloseIntentsByEnvironment'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

type WorktreeNamingRow = { worktreeId: string }

function repointRow(
  row: WorktreeNamingRow,
  oldWorktreeId: string,
  newWorktreeId: string
): WorktreeNamingRow | null {
  return row?.worktreeId === oldWorktreeId ? { ...row, worktreeId: newWorktreeId } : null
}

function repointRowRecord(
  session: WorkspaceSessionState,
  field: (typeof WORKTREE_ROW_RECORD_SESSION_FIELDS)[number],
  oldWorktreeId: string,
  newWorktreeId: string
): boolean {
  const record = session[field] as Record<string, WorktreeNamingRow> | undefined
  if (!record) {
    return false
  }
  const next: Record<string, WorktreeNamingRow> = { ...record }
  let changed = false
  for (const [key, row] of Object.entries(next)) {
    const repointed = repointRow(row, oldWorktreeId, newWorktreeId)
    if (repointed) {
      next[key] = repointed
      changed = true
    }
  }
  if (changed) {
    ;(session as Record<string, unknown>)[field] = next
  }
  return changed
}

function repointRowArrays(
  session: WorkspaceSessionState,
  field: (typeof WORKTREE_ROW_ARRAY_SESSION_FIELDS)[number],
  oldWorktreeId: string,
  newWorktreeId: string
): boolean {
  const record = session[field] as Record<string, WorktreeNamingRow[]> | undefined
  if (!record) {
    return false
  }
  const next: Record<string, WorktreeNamingRow[]> = { ...record }
  let changed = false
  for (const [key, rows] of Object.entries(next)) {
    if (!Array.isArray(rows) || !rows.some((row) => row?.worktreeId === oldWorktreeId)) {
      continue
    }
    next[key] = rows.map((row) => repointRow(row, oldWorktreeId, newWorktreeId) ?? row)
    changed = true
  }
  if (changed) {
    ;(session as Record<string, unknown>)[field] = next
  }
  return changed
}

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
  const oldWorktreePath = splitWorktreeIdForFilesystem(oldWorktreeId)?.worktreePath
  const newWorktreePath = splitWorktreeIdForFilesystem(newWorktreeId)?.worktreePath
  const withNewBrowserWorktreeId = <T extends BrowserPage | BrowserWorkspace>(value: T): T => {
    const renamedValue = withNewWorktreeId(value)
    return value.docLocation?.worktreeId === oldWorktreeId
      ? {
          ...renamedValue,
          docLocation: remapBrowserPageDocLocation(
            value.docLocation,
            oldWorktreeId,
            newWorktreeId,
            oldWorktreePath,
            newWorktreePath
          )
        }
      : renamedValue
  }
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
        workspaces.map(withNewBrowserWorktreeId)
      ) || sessionChanged
    if (session.browserPagesByWorkspace) {
      let pagesChanged = false
      const nextPagesByWorkspace = { ...session.browserPagesByWorkspace }
      for (const [workspaceId, pages] of Object.entries(nextPagesByWorkspace)) {
        if (
          !pages.some(
            (page) =>
              page.worktreeId === oldWorktreeId || page.docLocation?.worktreeId === oldWorktreeId
          )
        ) {
          continue
        }
        nextPagesByWorkspace[workspaceId] = pages.map(withNewBrowserWorktreeId)
        pagesChanged = true
      }
      if (pagesChanged) {
        session.browserPagesByWorkspace = nextPagesByWorkspace
        sessionChanged = true
      }
    }
    // Why the row too: rehydration only republishes a row whose `workspaceId` still equals the key
    // it is filed under, so re-keying the map alone would strand every page under the new id.
    sessionChanged =
      moveSessionKey(session.clientHostedBrowserPagesByWorktree, (rows) =>
        rows.map((row) =>
          row.workspaceId === oldWorktreeId ? { ...row, workspaceId: newWorktreeId } : row
        )
      ) || sessionChanged
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
    // Why every row-valued map and not just the two that used to be here: a record keyed by pane or
    // tab id still names its worktree in the value, and a stale one silently stops matching. A
    // `closedTerminalTabTombstonesByTabId` row left on the old id never suppresses the tab it was
    // minted for and never gets acknowledged, so the remote merge re-adds a tab the user closed.
    for (const field of WORKTREE_ROW_RECORD_SESSION_FIELDS) {
      sessionChanged =
        repointRowRecord(session, field, oldWorktreeId, newWorktreeId) || sessionChanged
    }
    for (const field of WORKTREE_ROW_ARRAY_SESSION_FIELDS) {
      sessionChanged =
        repointRowArrays(session, field, oldWorktreeId, newWorktreeId) || sessionChanged
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
