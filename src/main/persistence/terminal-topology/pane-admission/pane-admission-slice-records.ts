// Which stored records a sliced load owns, so a window-owned write rewrites exactly those from the slice's save.

import { workspaceKeys } from '../../../../shared/workspace-layout/persistence/workspace-layout-load'
import { stableJson } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-report'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** How a field's records are keyed; `partition` fields hold no record a slice owns, with the reason. */
export type SliceFieldScope =
  | 'workspace'
  /** Keyed by workspace, with values naming tabs: the Loader follows a dropped row under any key. */
  | 'workspace-selection'
  | 'row'
  | 'pane'
  | 'closed-tab'
  | 'selection'
  | { partition: string }

const CARRIED = { partition: 'carried through every load unchanged' }
const PARTITION_VIEW = { partition: 'a partition-wide selection, not a workspace or tab' }

/** Every stored field: a new one fails typecheck until it is placed. */
export const SLICE_FIELD_SCOPES = {
  activeRepoId: PARTITION_VIEW,
  activeWorkspaceKey: PARTITION_VIEW,
  activeWorkspaceExecutionHostId: PARTITION_VIEW,
  activeWorktreeId: PARTITION_VIEW,
  activeTabId: 'selection',
  tabsByWorktree: 'workspace',
  terminalLayoutsByTabId: 'row',
  localOnlyScrollbackByTabId: { partition: 'a content fact every load passes through unchanged' },
  activeWorktreeIdsOnShutdown: CARRIED,
  openFilesByWorktree: 'workspace',
  activeFileIdByWorktree: 'workspace',
  markdownFrontmatterVisible: { partition: 'keyed by file, never written by pane commands' },
  browserTabsByWorktree: 'workspace',
  browserPagesByWorkspace: { partition: 'a content fact every load passes through unchanged' },
  activeBrowserTabIdByWorktree: 'workspace',
  clientHostedBrowserPagesByWorktree: 'workspace',
  clientHostedBrowserCloseIntentsByEnvironment: CARRIED,
  pairedTerminalTabCloseIntentsByEnvironment: CARRIED,
  activeTabTypeByWorktree: 'workspace',
  browserUrlHistory: CARRIED,
  workspaceDocHistory: CARRIED,
  activeTabIdByWorktree: 'workspace-selection',
  unifiedTabs: 'workspace',
  tabGroups: 'workspace',
  tabGroupLayouts: 'workspace',
  activeGroupIdByWorktree: 'workspace',
  activeConnectionIdsAtShutdown: CARRIED,
  remoteSessionIdsByTabId: 'row',
  desktopRelayOwnerByTabId: CARRIED,
  desktopRelayAdoptionVersion: CARRIED,
  lastVisitedAtByWorktreeId: 'workspace',
  defaultTerminalTabsAppliedByWorktreeId: 'workspace',
  sleepingAgentSessionsByPaneKey: 'pane',
  terminalPtyIncarnationsByPaneKey: 'pane',
  terminalTopologyRevisionByRepoId: { partition: 'keyed by repo, carried as stored' },
  terminalSurfaceTombstonesByPaneKey: { partition: 'a session holding any is never sliced' },
  closedTerminalTabTombstonesByTabId: 'closed-tab',
  closedTerminalPanesByPaneKey: 'pane'
} as const satisfies Record<keyof WorkspaceSessionState, SliceFieldScope>

type Json = Record<string, unknown>

const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function rowIdsOf(session: WorkspaceSessionState): Set<string> {
  const ids = new Set<string>()
  for (const rows of Object.values(session.tabsByWorktree ?? {})) {
    rows.forEach((row) => ids.add(row.id))
  }
  return ids
}

/**
 * Window-owned builds rewrote the partition from its load; rewrite the slice's own records from its save the same way
 * and keep every other record as stored. Invariant: the rewrite owns only keys the slice loaded or its save produced,
 * never by prefix, so it cannot delete a record it never loaded.
 */
export function rewriteSliceRecords(
  stored: WorkspaceSessionState,
  slice: WorkspaceSessionState,
  after: WorkspaceSessionState
): WorkspaceSessionState {
  const workspaces = new Set([...workspaceKeys(slice), ...workspaceKeys(after)])
  const sliceRows = rowIdsOf(slice)
  const savedRows = rowIdsOf(after)
  const [storedFields, sliceFields, savedFields]: Json[] = [stored, slice, after]
  let next: Json | null = null
  for (const [field, scope] of Object.entries(SLICE_FIELD_SCOPES)) {
    if (typeof scope !== 'string') {
      continue
    }
    const kept = storedFields[field]
    const saved = savedFields[field]
    if (scope === 'selection') {
      if (typeof kept === 'string' && sliceRows.has(kept) && kept !== saved) {
        next ??= { ...storedFields }
        if (saved === undefined) {
          delete next[field]
        } else {
          next[field] = saved
        }
      }
      continue
    }
    const keptMap = isRecord(kept) ? kept : undefined
    const savedMap = isRecord(saved) ? saved : undefined
    const loaded = isRecord(sliceFields[field]) ? sliceFields[field] : {}
    const owns = (key: string): boolean => {
      if (scope === 'workspace' || scope === 'workspace-selection') {
        const value = keptMap?.[key]
        // A selection naming a row the slice loaded and dropped follows the save under any key.
        return (
          workspaces.has(key) ||
          (scope === 'workspace-selection' &&
            typeof value === 'string' &&
            sliceRows.has(value) &&
            !savedRows.has(value))
        )
      }
      return Object.hasOwn(loaded, key) || (savedMap !== undefined && Object.hasOwn(savedMap, key))
    }
    let map: Json | null = null
    for (const key of new Set([...Object.keys(keptMap ?? {}), ...Object.keys(savedMap ?? {})])) {
      if (!owns(key)) {
        continue
      }
      const value = savedMap?.[key]
      if (stableJson(value) !== stableJson(keptMap?.[key])) {
        map ??= { ...keptMap }
        if (value === undefined) {
          delete map[key]
        } else {
          map[key] = value
        }
      }
    }
    if (map) {
      next ??= { ...storedFields }
      if (Object.keys(map).length === 0 && savedMap === undefined) {
        delete next[field]
      } else {
        next[field] = map
      }
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stored session with the slice's own records replaced by values from its save.
  return next ? (next as unknown as WorkspaceSessionState) : stored
}
