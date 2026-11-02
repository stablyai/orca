import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { filterWorkspaceSessionTabs } from '../../../shared/workspace-session-tab-filter'
import { savedSessionId } from '../saved-structured-agent-session-restoration'
import { structuredSessionPlacementAllowed } from './structured-session-placement'

/** This machine's saved layout without the chat tabs its records place elsewhere. One pass over
 *  the saved rows themselves: a layout round trip would restamp other hosts' tabs as local. */
export function withPlacedSavedChatTabs(
  session: WorkspaceSessionState,
  hostId: string | null | undefined
): WorkspaceSessionState {
  if (hostId && hostId !== LOCAL_EXECUTION_HOST_ID) {
    return session
  }
  return filterWorkspaceSessionTabs(session, (worktreeId, tab) => {
    // Null for anything but this machine's chats, which only their own host places.
    const sessionId = savedSessionId(tab)
    return !sessionId || structuredSessionPlacementAllowed(worktreeId, sessionId)
  })
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
