import type { AgentSessionRecordStore } from '../../../runtime/agent-session/records/agent-session-record-store'
import { StructuredAgentSessionObservedWork } from './structured-agent-session-observed-work'
import { readHostStructuredAgentSessionWork } from './structured-agent-session-read-work'
import { structuredAgentSessionHandoverAuthority } from '../delivery/structured-agent-session-handing-over'
import type { AgentSessionJournal } from '../../agent-session-journal/journal-store'

import type { StructuredAgentSessionHostSession } from '../host/structured-agent-session-host-types'
// Bind host sessions/store evidence to the projection while keeping shared projection code free of host types.

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

export async function hostStructuredAgentSessionCurrentWork(
  host: StructuredAgentSessionCurrentWorkHost,
  sessionId: string
): Promise<StructuredAgentSessionObservedWork | null> {
  const session = host.sessions.get(sessionId)
  if (!session) {
    return null
  }
  const { state } = await readHostStructuredAgentSessionWork(host, sessionId, { kind: 'state' })
  return new StructuredAgentSessionObservedWork(session.journal, state, session.journal.cursor())
}

/** Capture only live authority; SQL selects the bounded work population in one snapshot. */
export async function heldStructuredAgentSessionCurrentWork(
  store: StructuredAgentSessionCurrentWorkHost['store'],
  sessionId: string,
  journal: AgentSessionJournal,
  session:
    | Pick<StructuredAgentSessionHostSession, 'lastEndedChild' | 'operationalRevision' | 'child'>
    | undefined
): Promise<StructuredAgentSessionObservedWork> {
  const { state } = await journal.readWork(
    () => {
      const child = session?.child
      const held = child?.heldSends?.()
      return {
        handle: journal.observationHandle(),
        record: store.getConversation(sessionId),
        replaced: store.replacedRuntime(sessionId),
        ended: session?.lastEndedChild,
        child: child ? { fence: child.fence, heldSends: held && [...held] } : null,
        ...structuredAgentSessionHandoverAuthority(journal),
        openedThrough: journal.openingCursor(),
        operationalRevision: session?.operationalRevision ?? 0
      }
    },
    { kind: 'state' }
  )
  return new StructuredAgentSessionObservedWork(journal, state, journal.cursor())
}
