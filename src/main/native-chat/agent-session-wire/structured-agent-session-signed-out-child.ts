// A child that reported its agent is not signed in is replaced before the next send. Some agents
// read their saved login only when they start, so a sign-in made since reaches a new child only.

import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { activeStructuredAgentSessionTurnId } from '../../../shared/structured-agent-session-live-turn'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import type {
  StructuredAgentSessionHostSession,
  StructuredAgentSessionProviderChild
} from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** What the check reads of a conversation. */
type SignedOutReading = {
  child: StructuredAgentSessionProviderChild | null
  journal: {
    cursor(): AgentJournalCursor
    snapshot(): { items: readonly Pick<AgentJournalRenderItem, 'sequence' | 'body'>[] }
    submissions(): readonly Pick<AgentJournalSubmission, 'dispatchState' | 'fence' | 'rejection'>[]
  }
}

const signedOut = (failure: unknown): boolean =>
  readWholeAgentSessionFailureFact(failure)?.kind === 'notSignedIn'

/** The running child itself said it is not signed in: a send it rejected, or a row it wrote after
 *  it started. Derived from the journal, so a new child starts with nothing to clear. */
export function structuredAgentSessionChildReportedSignedOut(session: SignedOutReading): boolean {
  const { child, journal } = session
  if (!child?.startedAt || child.phase === 'starting' || child.close) {
    return false
  }
  // Each child holds its own fence, so a send rejected at it was rejected by this child.
  if (
    journal
      .submissions()
      .some(
        (submission) =>
          submission.dispatchState === 'rejected' &&
          submission.fence === child.fence &&
          signedOut(submission.rejection)
      )
  ) {
    return true
  }
  const { epoch, sequence } = child.startedAt
  return (
    journal.cursor().epoch === epoch &&
    journal
      .snapshot()
      .items.some(
        (item) =>
          item.sequence > sequence && item.body.kind === 'status' && signedOut(item.body.failure)
      )
  )
}

/** For a caller inside the session's serialize, before it hands the next send to the child. A turn
 *  still running keeps its child. A stop that fails leaves the close begun, which the start joins. */
export async function retireSignedOutStructuredAgentSessionChild(
  sessionId: string,
  session: Pick<StructuredAgentSessionHostSession, 'child' | 'journal'> | undefined,
  deps: {
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<void> {
  if (
    !session ||
    !structuredAgentSessionChildReportedSignedOut(session) ||
    activeStructuredAgentSessionTurnId(session.journal.snapshot().items) !== null
  ) {
    return
  }
  await deps.stopAgent(sessionId).catch((error: unknown) =>
    deps.logger.warn('replacing a signed-out agent failed', {
      scope: 'signed-out-child',
      sessionId,
      error
    })
  )
}
