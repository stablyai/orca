import { chatNameInputs, layoutNameInputs, terminalNameInputs } from '../orchestration-sender-name'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'

/** Excludes scrollback, focus, bells and other session bookkeeping from name invalidation. */
export function crewWorkspaceNames(session: WorkspaceSessionState | null | undefined) {
  return session
    ? {
        tabs: Object.entries(session.tabsByWorktree ?? {}).map(([id, tabs]) => [
          id,
          tabs.map(terminalNameInputs)
        ]),
        chats: Object.entries(session.unifiedTabs ?? {}).map(([id, tabs]) => [
          id,
          tabs.map(chatNameInputs)
        ]),
        layouts: Object.entries(session.terminalLayoutsByTabId ?? {}).map(([id, layout]) => [
          id,
          layoutNameInputs(layout)
        ])
      }
    : null
}
