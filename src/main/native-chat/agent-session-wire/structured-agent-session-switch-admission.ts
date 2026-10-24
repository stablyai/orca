// The chat's half of a switch to its terminal. Unlike a tab close, a switch never cuts work short
// (the user stops a reply first), so it is admitted only when the chat is idle, and its admission
// has no effect of its own: no start is aborted and nothing is stopped before it passes.

import { agentSessionLeaseOwnerVerdict } from '../../../shared/agent-session-lease-adjudication'
import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import { agentSessionRefusalError } from '../../../shared/agent-session-wire-refusals'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

/** In the chat's ordered step: refuses unless nothing is running, starting, queued or owed, then
 *  admits, stops through close's body, and proves the agent gone before anything starts elsewhere. */
export async function stopIdleStructuredAgentSessionForSwitch(input: {
  session: StructuredAgentSessionHostSession | undefined
  delivering: boolean
  idleSweep: {
    owesWork: (sessionId: string, session: StructuredAgentSessionHostSession) => boolean
  }
  stop: () => Promise<unknown>
  deps: StructuredAgentSessionHostDeps
  sessionId: string
}): Promise<void> {
  const { session, deps, sessionId, stop } = input
  const currentRecord = deps.store.getRecord(sessionId)
  const owesWork = deps.hasOwedSwitchWork ?? deps.hasOpenDispatch
  if (
    input.delivering ||
    (currentRecord !== null && owesWork?.(currentRecord) === true) ||
    (session !== undefined &&
      (session.child?.phase === 'starting' ||
        session.journal.submissions().some(isQueuedAgentJournalSubmission) ||
        (session.child !== null &&
          input.idleSweep.owesWork(session.params.envelope.sessionId, session))))
  ) {
    throw agentSessionRefusalError('agent_session_operation_invalid', { reason: 'turnActive' })
  }
  await stop()
  const lease = deps.store.getRecord(sessionId)?.lease
  if (!lease || agentSessionLeaseOwnerVerdict(lease) !== 'exited') {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'ownerUnproven' })
  }
}
