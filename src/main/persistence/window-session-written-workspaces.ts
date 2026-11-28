// The workspaces a window save changes in a main-owned layout. Its layout fields are main's own merge, which already names the keys it wrote; of the window's other fields only one is read per workspace.

import { parsePaneKey } from '../../shared/workspace-layout/stable-pane-id'
import {
  rowShareRef,
  worktreeShareRef
} from '../../shared/workspace-layout/persistence/workspace-layout-load-slice'
import type { TouchedSessionRecords } from '../../shared/workspace-layout/persistence/workspace-layout-record-patch'
import type { WorkspaceSessionEntriesPatch } from '../../shared/workspace-session/workspace-session-entries-patch'
import { isLayoutField } from './window-save-view'
import { isWorkspaceSessionRecord } from '../../shared/workspace-session/workspace-session-host-records'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../shared/workspace-session/workspace-session-state-types'
import type { WrittenWorkspaceScope } from './loading-store/workspace-sessions/workspace-session-write-listeners'

/**
 * What a field's keys name for the projection. `none`: no loaded workspace reads it (selections every reload
 * refreshes partition-wide, or records partition readers never see). `whole`: only a whole reload places it.
 */
type KeyedBy = 'workspace' | 'row' | 'pane' | 'closed-tab' | 'none' | 'whole'

const KEYED_BY = {
  activeRepoId: 'none',
  activeWorkspaceKey: 'none',
  activeWorkspaceExecutionHostId: 'none',
  activeWorktreeId: 'none',
  activeTabId: 'none',
  markdownFrontmatterVisible: 'none',
  tabsByWorktree: 'workspace',
  terminalLayoutsByTabId: 'row',
  localOnlyScrollbackByTabId: 'none',
  activeWorktreeIdsOnShutdown: 'none',
  openFilesByWorktree: 'workspace',
  activeFileIdByWorktree: 'none',
  browserTabsByWorktree: 'workspace',
  browserPagesByWorkspace: 'none',
  activeBrowserTabIdByWorktree: 'none',
  clientHostedBrowserPagesByWorktree: 'none',
  clientHostedBrowserCloseIntentsByEnvironment: 'none',
  pairedTerminalTabCloseIntentsByEnvironment: 'none',
  activeTabTypeByWorktree: 'none',
  browserUrlHistory: 'none',
  workspaceDocHistory: 'none',
  activeTabIdByWorktree: 'none',
  unifiedTabs: 'workspace',
  tabGroups: 'workspace',
  tabGroupLayouts: 'workspace',
  // The Loader files a workspace's unplaced browser tabs into its active group.
  activeGroupIdByWorktree: 'workspace',
  activeConnectionIdsAtShutdown: 'none',
  // Main recomputes it for every row, and the Loader reads it to fold rows.
  remoteSessionIdsByTabId: 'whole',
  desktopRelayOwnerByTabId: 'none',
  desktopRelayAdoptionVersion: 'none',
  lastVisitedAtByWorktreeId: 'none',
  defaultTerminalTabsAppliedByWorktreeId: 'none',
  sleepingAgentSessionsByPaneKey: 'pane',
  terminalPtyIncarnationsByPaneKey: 'pane',
  terminalTopologyRevisionByRepoId: 'none',
  terminalSurfaceTombstonesByPaneKey: 'whole',
  closedTerminalTabTombstonesByTabId: 'closed-tab',
  closedTerminalPanesByPaneKey: 'none'
} as const satisfies Record<keyof WorkspaceSessionState, KeyedBy>

const KEYED_BY_FIELD: Readonly<Record<string, KeyedBy>> = KEYED_BY

function keyedBy(field: string): KeyedBy {
  return Object.hasOwn(KEYED_BY_FIELD, field) ? KEYED_BY_FIELD[field]! : 'whole'
}

function recordOf(value: unknown, key: string): unknown {
  return isWorkspaceSessionRecord(value) ? value[key] : undefined
}

/** The keys a window reported changing in a field it sent as entries; null when it sent the field whole. */
function reportedKeys(
  entries: WorkspaceSessionEntriesPatch | undefined,
  field: string
): string[] | null {
  const changes = recordOf(entries?.entries, field)
  if (Object.hasOwn(isWorkspaceSessionRecord(entries?.fields) ? entries.fields : {}, field)) {
    return null
  }
  const set = recordOf(changes, 'set')
  const remove = recordOf(changes, 'remove')
  return isWorkspaceSessionRecord(set) &&
    Array.isArray(remove) &&
    remove.every((key) => typeof key === 'string')
    ? [...Object.keys(set), ...remove]
    : null
}

/** False when the key can only be placed by a whole reload. */
function addKey(
  written: { workspaces: Set<string>; refs: Set<string> },
  kind: KeyedBy,
  key: string,
  values: readonly unknown[]
): boolean {
  switch (kind) {
    case 'workspace':
      written.workspaces.add(key)
      return true
    case 'row':
      written.refs.add(rowShareRef(key))
      return true
    case 'pane': {
      const pane = parsePaneKey(key)
      if (pane) {
        written.refs.add(rowShareRef(pane.tabId))
      }
      return pane !== null
    }
    case 'closed-tab':
      for (const value of values) {
        const worktreeId = recordOf(value, 'worktreeId')
        if (typeof worktreeId === 'string') {
          written.refs.add(worktreeShareRef(worktreeId))
        }
      }
      return true
    case 'none':
      return true
    case 'whole':
      return false
  }
}

/**
 * `saved` is what main stores, `touched` the keys main's merge wrote to its layout fields, and `entries` the
 * window's changed keys when it sent only those. Undefined when only a whole reload is exact.
 */
export function windowWrittenWorkspaces(
  stored: WorkspaceSessionState,
  saved: WorkspaceSessionPatch,
  touched: TouchedSessionRecords,
  entries: WorkspaceSessionEntriesPatch | undefined
): WrittenWorkspaceScope | undefined {
  const written = { workspaces: new Set<string>(), refs: new Set<string>() }
  const storedFields: Readonly<Record<string, unknown>> = stored
  const savedFields: Readonly<Record<string, unknown>> = saved
  for (const field of Object.keys(saved)) {
    const kind = keyedBy(field)
    if (kind === 'none') {
      continue
    }
    // A layout field is main's merge; any other is the window's own value, which only its reported keys bound.
    const keys = isLayoutField(field)
      ? touched.has(field)
        ? touched.get(field)!
        : []
      : reportedKeys(entries, field)
    if (keys === null) {
      return undefined
    }
    for (const key of keys) {
      const values = [recordOf(savedFields[field], key), recordOf(storedFields[field], key)]
      if (!addKey(written, kind, key, values)) {
        return undefined
      }
    }
  }
  return written
}
