import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { withChatTabChanges, type ChatTabChange } from '../agent-session/agent-session-tab-layout'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import { structuredSessionPlacementAllowed } from './structured-session-placement'

/** This machine's saved layout without the chat tabs its records place elsewhere. */
export function withPlacedSavedChatTabs(
  session: WorkspaceSessionState,
  hostId: string | null | undefined
): WorkspaceSessionState {
  if (hostId && hostId !== LOCAL_EXECUTION_HOST_ID) {
    return session
  }
  let next = session
  for (const [worktreeId, tabs] of Object.entries(session.unifiedTabs ?? {})) {
    const closes: ChatTabChange[] = []
    for (const tab of tabs) {
      const sessionId = savedSessionId(tab)
      if (
        sessionId &&
        (!tab.executionHostId || tab.executionHostId === LOCAL_EXECUTION_HOST_ID) &&
        !structuredSessionPlacementAllowed(worktreeId, sessionId)
      ) {
        closes.push({ close: sessionId, tabId: tab.id })
      }
    }
    if (closes.length) {
      next = withChatTabChanges(LOCAL_EXECUTION_HOST_ID, next, worktreeId, closes) ?? next
    }
  }
  return next
}

/** A window's partial save plus whatever placing chat tabs changes in the layout it produces. */
export function withPlacedSavedChatTabPatch(
  stored: WorkspaceSessionState,
  patch: Partial<WorkspaceSessionState>,
  hostId: string | null | undefined
): Partial<WorkspaceSessionState> {
  if (!patch.unifiedTabs) {
    return patch
  }
  const merged: WorkspaceSessionState = { ...stored, ...patch }
  const placed = withPlacedSavedChatTabs(merged, hostId)
  return placed === merged
    ? patch
    : {
        ...patch,
        ...Object.fromEntries(
          Object.entries(placed).filter(
            ([key, value]) => value !== merged[key as keyof WorkspaceSessionState]
          )
        )
      }
}
