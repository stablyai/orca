// Bind host sessions/store evidence to the projection while keeping shared projection code free of host types.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  structuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWorkJournal
} from './structured-agent-session-current-work'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'

export type StructuredAgentSessionCurrentWorkHost = {
  store: Pick<AgentSessionRecordStore, 'getConversation' | 'replacedRuntime'>
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

export function hostStructuredAgentSessionCurrentWork(
  host: StructuredAgentSessionCurrentWorkHost,
  sessionId: string
): StructuredAgentSessionCurrentWork | null {
  const session = host.sessions.get(sessionId)
  return session
    ? heldStructuredAgentSessionCurrentWork(host.store, sessionId, session.journal, session)
    : null
}

/** Use identical child evidence for actions and display; explicitly absent children mean none held. */
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
    record: store.getConversation(sessionId),
    replaced: store.replacedRuntime(sessionId),
    child: session?.child ?? null,
    ...(ended ? { ended } : {}),
    revision: session?.operationalRevision ?? 0
  })
}
