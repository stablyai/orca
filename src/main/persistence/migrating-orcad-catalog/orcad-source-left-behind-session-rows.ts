import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { TabGroup } from '../../../shared/tab-types'
import { ORCA_BROWSER_PARTITION } from '../../../shared/constants'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { ownedEditorFileId } from '../../../shared/workspace-session-pane-ownership'
import { isOrcadSourceTabHost } from './orcad-source-workspace-session-eligibility'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'

/**
 * Saved rows the managed server cannot hold and that are no one's live work, removed from a copy
 * of one partition before export. The profile itself keeps them, so a downgrade still has them.
 */
export function withoutLeftBehindSessionRows(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope,
  /** "Move anyway": also every clean host-bound file, and tabs another host runs. */
  leaveBehind = false,
  /** Drafts too: only where a retained copy outlives the move (the host's own partition). */
  options: { leaveDrafts: boolean } = { leaveDrafts: false }
): WorkspaceSessionState {
  const owns = (ownerKey: string): boolean => orcadMigrationOwnerMatchesScope(ownerKey, scope)
  const isolated = new Set(
    Object.entries(session.browserTabsByWorktree ?? {}).flatMap(([ownerKey, workspaces]) =>
      owns(ownerKey) ? workspaces.filter(usesSessionProfile).map((workspace) => workspace.id) : []
    )
  )
  const hiddenFiles = hiddenHostBoundFiles(session, owns, leaveBehind, options.leaveDrafts)
  const foreignTabs = leaveBehind
    ? Object.entries(session.unifiedTabs ?? {}).flatMap(([ownerKey, tabs]) =>
        owns(ownerKey)
          ? tabs.filter(
              (tab) =>
                tab.executionHostId !== undefined &&
                !isOrcadSourceTabHost(tab.executionHostId, scope)
            )
          : []
      )
    : []
  const foreignTabIds = new Set(foreignTabs.map((tab) => tab.id))
  // Why both ids: the legacy terminal rows and their layouts are keyed by the terminal's entity id.
  const foreignTerminalIds = new Set(
    foreignTabs.filter((tab) => tab.contentType === 'terminal').flatMap((t) => [t.id, t.entityId])
  )
  if (isolated.size === 0 && hiddenFiles.size === 0 && foreignTabIds.size === 0) {
    return session
  }
  const keepsFile = (ownerKey: string, filePath: string): boolean =>
    !hiddenFiles.get(ownerKey)?.has(filePath)
  const droppedTabIds = new Set([
    ...foreignTabIds,
    ...Object.values(session.unifiedTabs ?? {})
      .flat()
      .filter((tab) => tab.contentType === 'browser' && isolated.has(tab.entityId))
      .map((tab) => tab.id),
    ...hiddenFileTabIds(session, hiddenFiles)
  ])
  // Built as a new object: this is an export copy, never a write to the saved layout.
  return structuredClone({
    ...session,
    browserTabsByWorktree: mapRows(session.browserTabsByWorktree, (_key, workspaces) =>
      workspaces.filter((workspace) => !isolated.has(workspace.id))
    ),
    browserPagesByWorkspace: Object.fromEntries(
      Object.entries(session.browserPagesByWorkspace ?? {}).filter(([id]) => !isolated.has(id))
    ),
    activeBrowserTabIdByWorktree: Object.fromEntries(
      Object.entries(session.activeBrowserTabIdByWorktree ?? {}).filter(
        ([, id]) => !isolated.has(id ?? '')
      )
    ),
    unifiedTabs: mapRows(session.unifiedTabs, (_key, tabs) =>
      tabs.filter((tab) => !droppedTabIds.has(tab.id))
    ),
    tabGroups: mapRows(session.tabGroups, (_key, groups) =>
      groups.map((group) => withoutTabs(group, droppedTabIds))
    ),
    openFilesByWorktree: mapRows(session.openFilesByWorktree, (ownerKey, files) =>
      files.filter((file) => keepsFile(ownerKey, file.filePath))
    ),
    activeFileIdByWorktree: Object.fromEntries(
      Object.entries(session.activeFileIdByWorktree ?? {}).filter(
        ([ownerKey, fileId]) => !fileId || keepsFile(ownerKey, fileId)
      )
    ),
    ...withoutForeignTerminalRows(session, foreignTerminalIds)
  })
}

/** The legacy terminal model still hydrates these, so a skipped tab must leave them too. */
function withoutForeignTerminalRows(
  session: WorkspaceSessionState,
  tabIds: ReadonlySet<string>
): Partial<WorkspaceSessionState> {
  if (tabIds.size === 0) {
    return {}
  }
  const keepTab = ([tabId]: [string, unknown]): boolean => !tabIds.has(tabId)
  // Same split as worktreeIdForPaneKey, so legacy `tab:0` keys match as well as UUID leaves.
  const keepPane = ([paneKey]: [string, unknown]): boolean =>
    !tabIds.has(paneKey.slice(0, Math.max(0, paneKey.lastIndexOf(':'))))
  const filtered = <T>(
    rows: Record<string, T> | undefined,
    keep: (entry: [string, T]) => boolean
  ): Record<string, T> | undefined =>
    rows ? Object.fromEntries(Object.entries(rows).filter(keep)) : rows
  return {
    tabsByWorktree: Object.fromEntries(
      Object.entries(session.tabsByWorktree).map(([ownerKey, tabs]) => [
        ownerKey,
        tabs.filter((tab) => !tabIds.has(tab.id))
      ])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(session.terminalLayoutsByTabId).filter(keepTab)
    ),
    activeTabIdByWorktree: filtered(
      session.activeTabIdByWorktree,
      ([, tabId]) => !tabIds.has(tabId ?? '')
    ),
    remoteSessionIdsByTabId: filtered(session.remoteSessionIdsByTabId, keepTab),
    localOnlyScrollbackByTabId: filtered(session.localOnlyScrollbackByTabId, keepTab),
    sleepingAgentSessionsByPaneKey: filtered(session.sleepingAgentSessionsByPaneKey, keepPane),
    terminalPtyIncarnationsByPaneKey: filtered(session.terminalPtyIncarnationsByPaneKey, keepPane),
    terminalSurfaceTombstonesByPaneKey: filtered(
      session.terminalSurfaceTombstonesByPaneKey,
      ([paneKey, tombstone]) => keepPane([paneKey, tombstone]) && !tabIds.has(tombstone.parentTabId)
    ),
    closedTerminalTabTombstonesByTabId: filtered(
      session.closedTerminalTabTombstonesByTabId,
      ([tabId]) => !tabIds.has(tabId)
    )
  }
}

/** Tabs that show a dropped file: kept, they would open as a blank pane on the server. */
function hiddenFileTabIds(
  session: WorkspaceSessionState,
  hiddenFiles: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  return Object.entries(session.unifiedTabs ?? {}).flatMap(([ownerKey, tabs]) => {
    const hidden = hiddenFiles.get(ownerKey)
    if (!hidden) {
      return []
    }
    const fileIds = new Set(
      (session.openFilesByWorktree?.[ownerKey] ?? []).flatMap((file) =>
        hidden.has(file.filePath)
          ? [file.filePath, ownedEditorFileId(file.filePath, ownerKey, file.runtimeEnvironmentId)]
          : []
      )
    )
    return tabs
      .filter(
        (tab) =>
          tab.contentType !== 'terminal' &&
          tab.contentType !== 'browser' &&
          (fileIds.has(tab.id) || fileIds.has(tab.entityId))
      )
      .map((tab) => tab.id)
  })
}

function mapRows<T>(
  rows: Record<string, T[]> | undefined,
  map: (ownerKey: string, row: T[]) => T[]
): Record<string, T[]> | undefined {
  return rows
    ? Object.fromEntries(Object.entries(rows).map(([key, row]) => [key, map(key, row)]))
    : rows
}

function withoutTabs(group: TabGroup, tabIds: ReadonlySet<string>): TabGroup {
  const tabOrder = group.tabOrder.filter((id) => !tabIds.has(id))
  const recentTabIds = group.recentTabIds?.filter((id) => !tabIds.has(id))
  const activeTabId =
    group.activeTabId && tabIds.has(group.activeTabId)
      ? (recentTabIds?.at(-1) ?? tabOrder[0] ?? null)
      : group.activeTabId
  return { ...group, tabOrder, ...(recentTabIds ? { recentTabIds } : {}), activeTabId }
}

/** Whether a partition is some Orca profile's shared browser default rather than a session profile. */
export function isOrcaProfileBrowserDefaultPartition(partition: string): boolean {
  return (
    partition === ORCA_BROWSER_PARTITION ||
    (partition.startsWith('persist:orca-profile-') &&
      partition.endsWith('-browser-default') &&
      !partition.includes('-browser-session-'))
  )
}

/**
 * Isolated or imported login profiles are this desktop's alone and the server stores none, so the
 * tab stays behind rather than reopen on the shared profile. A tab switched back to Default keeps
 * the default partition and moves as usual.
 */
function usesSessionProfile(workspace: BrowserWorkspace): boolean {
  const { sessionProfileId, sessionPartition } = workspace
  return (
    (sessionProfileId ? sessionProfileId !== 'default' : false) ||
    (sessionPartition ? !isOrcaProfileBrowserDefaultPartition(sessionPartition) : false)
  )
}

/**
 * Clean editor files bound to another host that no tab shows. The user cannot see or close them,
 * and the server cannot hold them; one with an unsaved draft is never in this set.
 */
function hiddenHostBoundFiles(
  session: WorkspaceSessionState,
  owns: (ownerKey: string) => boolean,
  leaveBehind: boolean,
  leaveDrafts: boolean
): Map<string, Set<string>> {
  const hidden = new Map<string, Set<string>>()
  // Without the unified model, hydration shows every saved file as a tab.
  if (!leaveBehind && (!session.unifiedTabs || !session.tabGroups)) {
    return hidden
  }
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (!owns(ownerKey)) {
      continue
    }
    const shown = new Set(
      (session.unifiedTabs?.[ownerKey] ?? []).flatMap((tab) => [tab.id, tab.entityId])
    )
    for (const file of files) {
      const hostBound = file.externalSshTargetId !== undefined || Boolean(file.runtimeEnvironmentId)
      const visible =
        shown.has(file.filePath) ||
        shown.has(ownedEditorFileId(file.filePath, ownerKey, file.runtimeEnvironmentId))
      const clean = file.dirtyDraftContent === undefined
      if (hostBound && (clean || (leaveBehind && leaveDrafts)) && (leaveBehind || !visible)) {
        hidden.set(ownerKey, (hidden.get(ownerKey) ?? new Set()).add(file.filePath))
      }
    }
  }
  return hidden
}
