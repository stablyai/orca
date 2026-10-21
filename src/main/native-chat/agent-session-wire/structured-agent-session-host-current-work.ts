// The host's current-work projection (`structured-agent-session-current-work.ts`) for a chat it
// holds, read from its sessions and lease store. Apart from the projection itself, which stays free
// of host types so shared and client code can import it.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  structuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWorkJournal
} from './structured-agent-session-current-work'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

/** The host's sessions and lease store, as the projection reads them. */
export type StructuredAgentSessionCurrentWorkHost = {
  store: Pick<AgentSessionRecordStore, 'getRecord' | 'replacedRuntime'>
  sessions: {
    get(
      sessionId: string
    ):
      | Pick<
          StructuredAgentSessionHostSession,
          'journal' | 'lastEndedChild' | 'operationalRevision' | 'child'
        >
      | undefined
  }
}

/** A held chat's current work; null when this host holds no conversation for it. */
export function hostStructuredAgentSessionCurrentWork(
  host: StructuredAgentSessionCurrentWorkHost,
  sessionId: string
): StructuredAgentSessionCurrentWork | null {
  const session = host.sessions.get(sessionId)
  return session
    ? heldStructuredAgentSessionCurrentWork(host.store, sessionId, session.journal, session)
    : null
}

/** The one current work every host reader decides and displays by: this host's child is always
 *  evidence (none held reads as none), so an action never reads work the display does not show. */
export function heldStructuredAgentSessionCurrentWork(
  store: StructuredAgentSessionCurrentWorkHost['store'],
  sessionId: string,
  journal: StructuredAgentSessionCurrentWorkJournal,
  session:
    | Pick<StructuredAgentSessionHostSession, 'lastEndedChild' | 'operationalRevision' | 'child'>
    | undefined
): StructuredAgentSessionCurrentWork {
  const ended = session?.lastEndedChild
  return structuredAgentSessionCurrentWork(journal, {
    record: store.getRecord(sessionId),
    replaced: store.replacedRuntime(sessionId),
    child: session?.child ?? null,
    ...(ended ? { ended } : {}),
    revision: session?.operationalRevision ?? 0
  })
}
