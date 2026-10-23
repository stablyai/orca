// The next queued message to hand over: none while a send ahead is still opening its turn.

import { structuredAgentSessionSendOpeningTurn } from '../../../shared/structured-agent-session-opening-send'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { oldestQueuedSubmission } from './structured-agent-session-start-failure-row'

/** Whether a send this child (`fence`) was handed is still opening its turn
 *  (`structuredAgentSessionSendOpeningTurn`), read off the journal's fold without a snapshot. */
export function structuredAgentSessionSendOpeningTurnInJournal(
  journal: Pick<AgentSessionJournal, 'submissions' | 'visitItemsWithLinkage'>,
  fence: number,
  work?: Pick<StructuredAgentSessionCurrentWork, 'owesSend'> | null
): boolean {
  return structuredAgentSessionSendOpeningTurn(
    work
      ? journal.submissions().filter((submission) => work.owesSend(submission))
      : journal.submissions(),
    (visit) =>
      journal.visitItemsWithLinkage((itemId, sequence, body, linkage) =>
        visit({ itemId, sequence, body, turnScope: linkage.turnScope, agentId: linkage.agentId })
      ),
    fence
  )
}

/** The queued message to hand over now: the oldest, unless a send ahead is still opening its turn,
 *  when none is, and the commit that ends that wakes the delivery loop again. */
export function structuredAgentSessionNextHandover(
  session: Pick<StructuredAgentSessionHostSession, 'journal'>,
  fence: number,
  work?: Pick<StructuredAgentSessionCurrentWork, 'owesSend'> | null
): ReturnType<typeof oldestQueuedSubmission> {
  return structuredAgentSessionSendOpeningTurnInJournal(session.journal, fence, work)
    ? undefined
    : oldestQueuedSubmission(session)
}
