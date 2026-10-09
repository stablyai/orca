import { parseOrcaSessionAddress, type OrcaSessionId } from '../../../shared/orca-session-address'
import { structuredWorkerOrcaSessionIdForIncarnation } from '../structured-worker-identity'

/**
 * The Orca session id a Dispatch row stores for its assignee: the structured worker its process
 * incarnation names, or the chat its `orca_session_id:` handle names. A PTY has none.
 */
export function dispatchAssigneeOrcaSessionId(assignee: {
  handle: string
  processIncarnation: string | null | undefined
}): OrcaSessionId | null {
  return (
    structuredWorkerOrcaSessionIdForIncarnation(assignee.processIncarnation) ??
    parseOrcaSessionAddress(assignee.handle)
  )
}
