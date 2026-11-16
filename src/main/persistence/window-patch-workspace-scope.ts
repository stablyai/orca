// Scope a window layout patch to the workspaces it changes, so one tab edit does not clone, load and save the whole fleet's layout.

import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { sameJson } from '../../shared/workspace-layout/persistence/workspace-layout-record-patch'
import {
  addWorkspaceIds,
  asJson,
  emptyWorkspaceIds,
  field,
  fieldsOf,
  idsByWorkspace,
  isRecord,
  sharesWorkspaceIds,
  workspaceKeys,
  type Json
} from './window-patch-workspace-ids'

type FieldKey = 'whole' | 'workspace' | 'tab' | 'pane' | 'closed-tab'

/** How each stored field is keyed; a new field fails typecheck until it is placed. */
const FIELD_KEYS = {
  activeRepoId: 'whole',
  activeWorkspaceKey: 'whole',
  activeWorkspaceExecutionHostId: 'whole',
  activeWorktreeId: 'whole',
  activeTabId: 'whole',
  tabsByWorktree: 'workspace',
  terminalLayoutsByTabId: 'tab',
  localOnlyScrollbackByTabId: 'tab',
  activeWorktreeIdsOnShutdown: 'whole',
  openFilesByWorktree: 'workspace',
  activeFileIdByWorktree: 'workspace',
  markdownFrontmatterVisible: 'whole',
  browserTabsByWorktree: 'workspace',
  browserPagesByWorkspace: 'tab',
  activeBrowserTabIdByWorktree: 'workspace',
  clientHostedBrowserPagesByWorktree: 'workspace',
  clientHostedBrowserCloseIntentsByEnvironment: 'whole',
  pairedTerminalTabCloseIntentsByEnvironment: 'whole',
  activeTabTypeByWorktree: 'workspace',
  browserUrlHistory: 'whole',
  workspaceDocHistory: 'whole',
  activeTabIdByWorktree: 'workspace',
  unifiedTabs: 'workspace',
  tabGroups: 'workspace',
  tabGroupLayouts: 'workspace',
  activeGroupIdByWorktree: 'workspace',
  activeConnectionIdsAtShutdown: 'whole',
  remoteSessionIdsByTabId: 'whole',
  lastVisitedAtByWorktreeId: 'workspace',
  defaultTerminalTabsAppliedByWorktreeId: 'workspace',
  sleepingAgentSessionsByPaneKey: 'pane',
  terminalPtyIncarnationsByPaneKey: 'pane',
  terminalTopologyRevisionByRepoId: 'whole',
  // Legacy tombstones retire panes across workspaces: their presence takes the full path.
  terminalSurfaceTombstonesByPaneKey: 'pane',
  closedTerminalTabTombstonesByTabId: 'closed-tab',
  closedTerminalPanesByPaneKey: 'pane'
} as const satisfies Record<keyof WorkspaceSessionState, FieldKey>

const KEYS: Readonly<Record<string, FieldKey>> = FIELD_KEYS

export type WorkspacePatchScope = {
  stored: WorkspaceSessionState
  window: WorkspaceSessionState
  /** The field's value over all workspaces, given its value joined over the scoped ones. */
  merge: (field: string, scoped: unknown) => unknown
}

type Owns = (key: FieldKey, entryKey: string, entry: unknown) => boolean

function paneTabId(paneKey: string): string {
  const split = paneKey.lastIndexOf(':')
  return split === -1 ? paneKey : paneKey.slice(0, split)
}

/** Keep the touched workspaces' records; fields keyed by nothing stay whole. */
function restrict(session: WorkspaceSessionState, owns: Owns): WorkspaceSessionState {
  const scoped: Json = {}
  for (const [name, value] of Object.entries(fieldsOf(session))) {
    const key = KEYS[name] ?? 'whole'
    scoped[name] =
      key === 'whole' || !isRecord(value)
        ? value
        : Object.fromEntries(
            Object.entries(value).filter(([entryKey, entry]) => owns(key, entryKey, entry))
          )
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every field is the session's own value or a subset of its own map.
  return scoped as WorkspaceSessionState
}

/** Stored entries outside the scope, in stored order, with the scoped join's entries in their place. */
function mergeScoped(name: string, base: unknown, scoped: unknown, owns: Owns): unknown {
  const key = KEYS[name] ?? 'whole'
  if (key === 'whole' || !isRecord(base) || (scoped !== undefined && !isRecord(scoped))) {
    return scoped
  }
  const next = asJson(scoped)
  const result: Json = {}
  for (const [entryKey, entry] of Object.entries(base)) {
    if (!owns(key, entryKey, entry)) {
      result[entryKey] = entry
    } else if (Object.hasOwn(next, entryKey)) {
      result[entryKey] = next[entryKey]
    }
  }
  for (const [entryKey, entry] of Object.entries(next)) {
    if (!Object.hasOwn(base, entryKey)) {
      result[entryKey] = entry
    }
  }
  // An emptied map is dropped, as the full save drops it.
  return scoped === undefined && Object.keys(result).length === 0 ? undefined : result
}

/** Null when the patch reaches records the Loader resolves across workspaces: take the full path. */
export function scopeWindowPatch(
  stored: WorkspaceSessionState,
  window: WorkspaceSessionState,
  patchFields: readonly string[]
): WorkspacePatchScope | null {
  if (
    Object.keys(asJson(stored.terminalSurfaceTombstonesByPaneKey)).length > 0 ||
    Object.keys(asJson(window.terminalSurfaceTombstonesByPaneKey)).length > 0
  ) {
    return null
  }
  const ids = idsByWorkspace([stored, window])
  const tabOwners = new Map<string, string[]>()
  for (const [key, workspace] of ids) {
    for (const tabId of workspace.tabs) {
      tabOwners.set(tabId, [...(tabOwners.get(tabId) ?? []), key])
    }
  }
  const touched = new Set<string>()
  for (const name of patchFields) {
    const key = KEYS[name] ?? 'whole'
    if (key === 'whole') {
      continue
    }
    const before = field(stored, name)
    const after = field(window, name)
    for (const entryKey of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (sameJson(before[entryKey], after[entryKey])) {
        continue
      }
      if (key === 'workspace') {
        touched.add(entryKey)
        continue
      }
      const worktreeIds = [before[entryKey], after[entryKey]].map((record) =>
        String(asJson(record).worktreeId)
      )
      const owners =
        key === 'closed-tab'
          ? [...ids].flatMap(([workspace, { worktrees }]) =>
              worktreeIds.some((id) => worktrees.has(id)) ? [workspace] : []
            )
          : (tabOwners.get(key === 'pane' ? paneTabId(entryKey) : entryKey) ?? [])
      if (owners.length === 0) {
        return null
      }
      owners.forEach((owner) => touched.add(owner))
    }
  }
  // Joining the window view gives visited empty workspaces owner rows (window-save-view withVisitedRowOwners).
  const present = workspaceKeys(stored)
  for (const key of Object.keys(asJson(window.lastVisitedAtByWorktreeId))) {
    if (present.has(key) && !Object.hasOwn(asJson(stored.tabsByWorktree), key)) {
      touched.add(key)
    }
  }
  const scope = emptyWorkspaceIds()
  touched.forEach((key) => addWorkspaceIds(scope, ids.get(key)))
  for (const [key, workspace] of ids) {
    if (!touched.has(key) && sharesWorkspaceIds(workspace, scope)) {
      return null
    }
  }
  const owns: Owns = (key, entryKey, entry) => {
    switch (key) {
      case 'workspace':
        return touched.has(entryKey)
      case 'tab':
        return scope.tabs.has(entryKey)
      case 'pane':
        return scope.tabs.has(paneTabId(entryKey))
      case 'closed-tab':
        return scope.worktrees.has(String(asJson(entry).worktreeId))
      case 'whole':
        return true
    }
  }
  return {
    stored: restrict(stored, owns),
    window: restrict(window, owns),
    merge: (name, scoped) => mergeScoped(name, fieldsOf(stored)[name], scoped, owns)
  }
}
