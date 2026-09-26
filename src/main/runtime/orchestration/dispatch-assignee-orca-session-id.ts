import { parseOrcaSessionAddress, type OrcaSessionId } from '../../../shared/orca-session-address'
import { structuredWorkerOrcaSessionIdForIncarnation } from '../structured-worker-identity'
import { canonicalOrcaSessionId } from './canonical-orca-session-id'

/**
 * The Orca session id a Dispatch row stores for its assignee: the structured worker a process
 * incarnation names, or the chat a `session:<id>` assignee handle names. A PTY has none.
 */
export function dispatchAssigneeOrcaSessionId(assignee: {
  handle: string
  processIncarnation: string | null | undefined
}): OrcaSessionId | null {
  const orcaSessionId =
    structuredWorkerOrcaSessionIdForIncarnation(assignee.processIncarnation) ??
    parseOrcaSessionAddress(assignee.handle)
  return orcaSessionId === null ? null : canonicalOrcaSessionId(orcaSessionId)
}
