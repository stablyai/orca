// A child that reported its agent is not signed in is replaced before the next send. Some agents
// read their saved login only when they start, so a sign-in made since reaches a new child only.

import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** What the check reads of a conversation; every read skips building a snapshot. */
type SignedOutReading = Pick<StructuredAgentSessionHostSession, 'child'> & {
  journal: Pick<AgentSessionJournal, 'visitItems' | 'itemFence' | 'activeTurnId'> & {
    submissions(): readonly Pick<AgentJournalSubmission, 'dispatchState' | 'fence' | 'rejection'>[]
  }
}

const signedOut = (failure: unknown): boolean =>
  readWholeAgentSessionFailureFact(failure)?.kind === 'notSignedIn'

/** The running child itself said it is not signed in: a send it rejected, or a row it wrote. Each
 *  child holds its own fence, so matching it scopes both to this child; a new one has nothing. */
export function structuredAgentSessionChildReportedSignedOut(session: SignedOutReading): boolean {
  const { child, journal } = session
  if (!child || child.phase === 'starting' || child.close) {
    return false
  }
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
  let found = false
  journal.visitItems((itemId, _sequence, body) => {
    found ||=
      body.kind === 'status' && signedOut(body.failure) && journal.itemFence(itemId) === child.fence
  })
  return found
}

/** For a caller inside the session's serialize, before it hands the next send to the child. A turn
 *  still running keeps its child. A stop that fails leaves the close begun, which the start joins. */
export async function retireSignedOutStructuredAgentSessionChild(
  sessionId: string,
  session: SignedOutReading | undefined,
  deps: {
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<void> {
  if (
    !session ||
    !structuredAgentSessionChildReportedSignedOut(session) ||
    session.journal.activeTurnId() !== null
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
