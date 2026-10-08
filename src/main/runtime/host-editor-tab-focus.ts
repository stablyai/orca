import type {
  RuntimeMobileSessionSnapshotTab,
  RuntimeMobileSessionTabGroup,
  RuntimeMobileSessionTabsSnapshot
} from '../../shared/runtime-types'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { HostEditorMobileTab } from './host-editor-tab-projection'

export type HostEditorFocus = {
  /** A tab the host just focused (an open or activation that targets the host). */
  tabId?: string
  /** A fresh build has no current focus of its own, so the persisted one wins. */
  preferPersistedEditorFocus?: boolean
}

export function topLevelTabId(tab: RuntimeMobileSessionSnapshotTab): string {
  return tab.type === 'terminal' ? tab.parentTabId : tab.id
}

function persistedEditorFocus(
  worktreeId: string,
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null
): HostEditorMobileTab | undefined {
  const persistedActiveFileId = session?.activeFileIdByWorktree?.[worktreeId]
  if (session?.activeTabTypeByWorktree?.[worktreeId] !== 'editor' || !persistedActiveFileId) {
    return undefined
  }
  const activeGroupId = session.activeGroupIdByWorktree?.[worktreeId]
  const persistedGroupActiveTabId = session.tabGroups?.[worktreeId]?.find(
    (group) => group.id === activeGroupId
  )?.activeTabId
  const candidates = editors.filter((editor) => editor.fileId === persistedActiveFileId)
  return candidates.find((editor) => editor.tab.id === persistedGroupActiveTabId) ?? candidates[0]
}

/** The surface a top-level id names: itself, or the active pane of a terminal tab. */
function findTopLevelSurface(
  tabs: readonly RuntimeMobileSessionSnapshotTab[],
  topLevelId: string | null | undefined
): RuntimeMobileSessionSnapshotTab | undefined {
  if (!topLevelId) {
    return undefined
  }
  const surfaces = tabs.filter((tab) => topLevelTabId(tab) === topLevelId)
  return surfaces.find((tab) => tab.isActive) ?? surfaces[0]
}

/**
 * Focus order: an explicit host focus, then whatever the snapshot already shows (so a later
 * terminal activation is not overridden), then the persisted editor focus a restart restores,
 * then the active group's most recent tab, as a window does after its focused tab closes.
 */
export function pickActiveTabId(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  candidateTabs: readonly RuntimeMobileSessionSnapshotTab[],
  editors: readonly HostEditorMobileTab[],
  session: WorkspaceSessionState | null,
  focus: HostEditorFocus,
  groups: readonly RuntimeMobileSessionTabGroup[]
): string | null {
  const nextTabIds = new Set(candidateTabs.map((tab) => tab.id))
  if (focus.tabId && nextTabIds.has(focus.tabId)) {
    return focus.tabId
  }
  const persisted = persistedEditorFocus(snapshot.worktree, editors, session)
  if (focus.preferPersistedEditorFocus && persisted) {
    return persisted.tab.id
  }
  if (snapshot.activeTabId && nextTabIds.has(snapshot.activeTabId)) {
    return snapshot.activeTabId
  }
  if (persisted) {
    return persisted.tab.id
  }
  const activeGroup =
    groups.find((group) => group.id === snapshot.activeGroupId) ??
    groups.find((group) => group.id === session?.activeGroupIdByWorktree?.[snapshot.worktree]) ??
    groups[0]
  return (
    (
      findTopLevelSurface(candidateTabs, activeGroup?.activeTabId) ??
      findTopLevelSurface(candidateTabs, session?.activeTabIdByWorktree?.[snapshot.worktree]) ??
      candidateTabs[0]
    )?.id ?? null
  )
}
