import { structuredAgentSessionSendOpeningTurn } from '../../../shared/structured-agent-session-opening-send'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { oldestQueuedSubmission } from './structured-agent-session-start-failure-row'

/** Read opening-turn evidence from the journal fold without a snapshot. */
export function structuredAgentSessionSendOpeningTurnInJournal(
  journal: Pick<AgentSessionJournal, 'submissions' | 'visitItemsWithLinkage'>,
  fence: number,
  work?: Pick<StructuredAgentSessionCurrentWork, 'publishedSubmission'> | null
): boolean {
  return structuredAgentSessionSendOpeningTurn(
    // Released held sends no longer count as opening turns.
    work ? journal.submissions().map(work.publishedSubmission) : journal.submissions(),
    (visit) =>
      journal.visitItemsWithLinkage((itemId, sequence, body, linkage) =>
        visit({ itemId, sequence, body, turnScope: linkage.turnScope, agentId: linkage.agentId })
      ),
    fence
  )
}

/** Oldest pending send, unless an earlier send still opens its turn; settlement wakes delivery. */
export function structuredAgentSessionNextHandover(
  session: Pick<StructuredAgentSessionHostSession, 'journal'>,
  fence: number,
  work?: Pick<StructuredAgentSessionCurrentWork, 'publishedSubmission'> | null
): ReturnType<typeof oldestQueuedSubmission> {
  return structuredAgentSessionSendOpeningTurnInJournal(session.journal, fence, work)
    ? undefined
    : oldestQueuedSubmission(session)
}
