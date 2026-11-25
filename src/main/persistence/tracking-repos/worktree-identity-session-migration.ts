import type {
  BrowserPage,
  BrowserWorkspace
} from '../../../shared/browser/workspaces/browser-workspace-types'
import { remapBrowserPageDocLocation } from '../../../shared/browser/workspaces/browser-page-doc-location'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import { repointRowArrays, repointRowRecord } from './worktree-identity-row-repoint'

/** A new session with the worktree moved, or null; published sessions are never edited. */
export function migrateWorkspaceSessionWorktreeIdentity(
  session: WorkspaceSessionState,
  oldWorktreeId: string,
  newWorktreeId: string
): WorkspaceSessionState | null {
  const oldWorkspaceKey = worktreeWorkspaceKey(oldWorktreeId)
  const newWorkspaceKey = worktreeWorkspaceKey(newWorktreeId)
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
  let next: WorkspaceSessionState | null = null
  const edit = (): WorkspaceSessionState => (next ??= { ...session })
  const setField = <K extends keyof WorkspaceSessionState>(
    field: K,
    moved: WorkspaceSessionState[K] | undefined
  ): void => {
    if (moved !== undefined) {
      edit()[field] = moved
    }
  }
  /** Known collision: source overwrites existing target on partial/repeated moves; no revision proves which is newer. */
  const moveSessionKey = <T>(
    record: Record<string, T> | undefined,
    mapValue: (value: T) => T = (value) => value
  ): Record<string, T> | undefined => {
    let moved: Record<string, T> | undefined
    const pairs: [string, string][] = [
      [oldWorktreeId, newWorktreeId],
      [oldWorkspaceKey, newWorkspaceKey]
    ]
    for (const [oldKey, newKey] of pairs) {
      if (!record || !(oldKey in record)) {
        continue
      }
      moved ??= { ...record }
      moved[newKey] = mapValue(record[oldKey])
      delete moved[oldKey]
    }
    return moved
  }

  setField(
    'tabsByWorktree',
    moveSessionKey(session.tabsByWorktree, (tabs) => tabs.map(withNewWorktreeId))
  )
  setField(
    'openFilesByWorktree',
    moveSessionKey(session.openFilesByWorktree, (files) => files.map(withNewWorktreeId))
  )
  setField('activeFileIdByWorktree', moveSessionKey(session.activeFileIdByWorktree))
  setField(
    'browserTabsByWorktree',
    moveSessionKey(session.browserTabsByWorktree, (workspaces) =>
      workspaces.map(withNewBrowserWorktreeId)
    )
  )
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
      setField('browserPagesByWorkspace', nextPagesByWorkspace)
    }
  }
  // Rehydration requires workspaceId to match its map key; rekeying alone would strand pages.
  setField(
    'clientHostedBrowserPagesByWorktree',
    moveSessionKey(session.clientHostedBrowserPagesByWorktree, (rows) =>
      rows.map((row) =>
        row.workspaceId === oldWorktreeId ? { ...row, workspaceId: newWorktreeId } : row
      )
    )
  )
  setField('activeBrowserTabIdByWorktree', moveSessionKey(session.activeBrowserTabIdByWorktree))
  setField('activeTabTypeByWorktree', moveSessionKey(session.activeTabTypeByWorktree))
  setField('activeTabIdByWorktree', moveSessionKey(session.activeTabIdByWorktree))
  setField(
    'unifiedTabs',
    moveSessionKey(session.unifiedTabs, (tabs) => tabs.map(withNewWorktreeId))
  )
  setField(
    'tabGroups',
    moveSessionKey(session.tabGroups, (groups) => groups.map(withNewWorktreeId))
  )
  setField('tabGroupLayouts', moveSessionKey(session.tabGroupLayouts))
  setField('activeGroupIdByWorktree', moveSessionKey(session.activeGroupIdByWorktree))
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
      // Partial migrations can retain both IDs; max prevents recency regression.
      const existing = nextRecency[nextKey]
      nextRecency[nextKey] = existing === undefined ? value : Math.max(existing, value)
      delete nextRecency[key]
      recencyChanged = true
    }
    if (recencyChanged) {
      setField('lastVisitedAtByWorktreeId', nextRecency)
    }
  }
  setField(
    'defaultTerminalTabsAppliedByWorktreeId',
    moveSessionKey(session.defaultTerminalTabsAppliedByWorktreeId)
  )
  if (session.activeWorktreeIdsOnShutdown?.includes(oldWorktreeId)) {
    setField(
      'activeWorktreeIdsOnShutdown',
      session.activeWorktreeIdsOnShutdown.map((id) => (id === oldWorktreeId ? newWorktreeId : id))
    )
  }
  if (session.activeWorktreeId === oldWorktreeId) {
    setField('activeWorktreeId', newWorktreeId)
  }
  if (session.activeWorkspaceKey === oldWorkspaceKey) {
    setField('activeWorkspaceKey', newWorkspaceKey)
  }
  // Pane/tab/environment-keyed rows still carry worktree IDs in values; explicit typed fields retain census coverage.
  const nextSleeping = repointRowRecord(
    session.sleepingAgentSessionsByPaneKey,
    oldWorktreeId,
    newWorktreeId
  )
  if (nextSleeping) {
    setField('sleepingAgentSessionsByPaneKey', nextSleeping)
  }
  const nextSurfaceTombstones = repointRowRecord(
    session.terminalSurfaceTombstonesByPaneKey,
    oldWorktreeId,
    newWorktreeId
  )
  if (nextSurfaceTombstones) {
    setField('terminalSurfaceTombstonesByPaneKey', nextSurfaceTombstones)
  }
  const nextClosedTombstones = repointRowRecord(
    session.closedTerminalTabTombstonesByTabId,
    oldWorktreeId,
    newWorktreeId
  )
  if (nextClosedTombstones) {
    setField('closedTerminalTabTombstonesByTabId', nextClosedTombstones)
  }
  const nextClosedPanes = repointRowRecord(
    session.closedTerminalPanesByPaneKey,
    oldWorktreeId,
    newWorktreeId
  )
  if (nextClosedPanes) {
    setField('closedTerminalPanesByPaneKey', nextClosedPanes)
  }
  const nextCloseIntents = repointRowArrays(
    session.clientHostedBrowserCloseIntentsByEnvironment,
    oldWorktreeId,
    newWorktreeId
  )
  if (nextCloseIntents) {
    setField('clientHostedBrowserCloseIntentsByEnvironment', nextCloseIntents)
  }
  const nextPairedTabCloseIntents = repointRowArrays(
    session.pairedTerminalTabCloseIntentsByEnvironment,
    oldWorktreeId,
    newWorktreeId
  )
  if (nextPairedTabCloseIntents) {
    setField('pairedTerminalTabCloseIntentsByEnvironment', nextPairedTabCloseIntents)
  }
  return next
}
