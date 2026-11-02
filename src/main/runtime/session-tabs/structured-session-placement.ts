import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'

/** A readable local chat shows only in its record's workspace (any spelling of it); an unreadable,
 *  missing or other-host record proves nothing, so its row stays. Saved and raw rows are only hints. */
export function structuredSessionPlacementAllowed(workspaceId: string, sessionId: string): boolean {
  const store = getStructuredAgentSessionHost()?.deps?.store
  const location = store?.isSessionUnreadable?.(sessionId)
    ? null
    : store?.getRecord?.(sessionId)?.location
  return (
    !location ||
    location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    worktreeIdsEqual(location.workspaceId, workspaceId)
  )
}
