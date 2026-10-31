import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'

/** Excludes scrollback, focus, bells and other session bookkeeping from name invalidation. */
export function crewWorkspaceNames(session: WorkspaceSessionState | null | undefined) {
  return session
    ? {
        tabs: Object.entries(session.tabsByWorktree ?? {}).map(([id, tabs]) => [
          id,
          tabs.map((tab) => [tab.id, tab.title, tab.customTitle])
        ]),
        chats: Object.entries(session.unifiedTabs ?? {}).map(([id, tabs]) => [
          id,
          tabs.map((tab) => [tab.contentType, tab.entityId, tab.customLabel, tab.label])
        ]),
        layouts: Object.entries(session.terminalLayoutsByTabId ?? {}).map(([id, layout]) => [
          id,
          layout.root,
          layout.titlesByLeafId
        ])
      }
    : null
}
