// Bind host sessions/store evidence to the projection while keeping shared projection code free of host types.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import {
  structuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWork,
  type StructuredAgentSessionCurrentWorkJournal
} from './structured-agent-session-current-work'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export type StructuredAgentSessionCurrentWorkHost = {
  store: Pick<AgentSessionRecordStore, 'getConversation' | 'replacedRuntime'>
  /** Given where the work is published to clients, which show a start held for setup as not working. */
  setupHold?: StructuredAgentSessionHostDeps['setupHold']
  sessions: {
    get(
      sessionId: string
    ):
      | Pick<
          StructuredAgentSessionHostSession,
          'journal' | 'lastEndedChild' | 'operationalRevision' | 'child' | 'params'
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
    ? heldStructuredAgentSessionCurrentWork(
        host.store,
        sessionId,
        session.journal,
        session,
        structuredAgentSessionStartHeld(host.setupHold, session)
      )
    : null
}

/** Use identical child evidence for actions and display; explicitly absent children mean none held. */
export function heldStructuredAgentSessionCurrentWork(
  store: StructuredAgentSessionCurrentWorkHost['store'],
  sessionId: string,
  journal: StructuredAgentSessionCurrentWorkJournal,
  session:
    | Pick<StructuredAgentSessionHostSession, 'lastEndedChild' | 'operationalRevision' | 'child'>
    | undefined,
  startHeld = false
): StructuredAgentSessionCurrentWork {
  const ended = session?.lastEndedChild
  return structuredAgentSessionCurrentWork(journal, {
    record: store.getConversation(sessionId),
    replaced: store.replacedRuntime(sessionId),
    child: session?.child ?? null,
    ...(ended ? { ended } : {}),
    revision: session?.operationalRevision ?? 0,
    ...(startHeld ? { startHeld } : {})
  })
}

/** Re-read per publication: the workspace's setup holds this chat's agent start and none runs. */
export function structuredAgentSessionStartHeld(
  setupHold: StructuredAgentSessionHostDeps['setupHold'],
  session: { params: { location: { workspaceId: string } }; child?: unknown } | undefined
): boolean {
  return (
    session !== undefined &&
    !session.child &&
    setupHold?.(session.params.location.workspaceId) != null
  )
}
