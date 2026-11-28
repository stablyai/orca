import { getStructuredAgentSessionHost } from '../../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { sessionIdFromStructuredWorkerIncarnation } from './structured-worker-incarnation'

/** The store forgets a session only at rest and after its /clear successor, so a root gone from a
 *  loaded, writable store proves its lineage ended. A read-only or absent store proves nothing. */
export function structuredWorkerSessionForgotten(processIncarnation: string | null): boolean {
  const sessionId = sessionIdFromStructuredWorkerIncarnation(processIncarnation)
  try {
    const host = getStructuredAgentSessionHost()
    const store = host?.deps.store
    return (
      !!sessionId &&
      !!host &&
      !!store &&
      !store.readOnly &&
      store.getRecord(sessionId) === null &&
      !store.isSessionUnreadable(sessionId) &&
      !host.hasSession(sessionId)
    )
  } catch {
    return false
  }
}
