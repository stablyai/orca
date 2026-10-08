// A child that reported its agent is not signed in is replaced before the next send. Some agents
// read their saved login only when they start, so a sign-in made since reaches a new child only.

import { readWholeAgentSessionFailureFact } from '../../../shared/agent-session-failure'
import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import type { AgentJournalSubmission } from '../../../shared/agent-session-journal-types'
import type { AgentChildWorkView } from '../../../shared/agent-status-child-work-view'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { StructuredAgentSessionHostSession } from './structured-agent-session-host-types'
import {
  structuredAgentSessionChildHasOpenWork,
  type StructuredAgentSessionChildWorkReads
} from './structured-agent-session-idle-sweep'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'

/** What the check reads of a conversation; every read skips building a snapshot. */
type SignedOutReading = Pick<StructuredAgentSessionHostSession, 'child'> & {
  journal: Pick<
    AgentSessionJournal,
    'visitItems' | 'visitItemsWithLinkage' | 'itemFence' | 'activeTurnId' | 'newestTurn'
  > & {
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
  // The session's own agent only: a subagent's sign-in failure says nothing about its parent.
  let found = false
  journal.visitItemsWithLinkage((itemId, _sequence, body, attribution) => {
    found ||=
      body.kind === 'status' &&
      isRootAgentJournalItem(attribution) &&
      signedOut(body.failure) &&
      journal.itemFence(itemId) === child.fence
  })
  return found
}

/** Child work that settled after the lead's newest turn ended: the lead may still owe the turn
 *  that reads its result, which journals nothing until it opens. The idle sweep's window covers
 *  this; a restart before the next send has none, so it waits for that turn. */
function owesWakeUp(
  journal: Pick<AgentSessionJournal, 'newestTurn'>,
  childWork: readonly AgentChildWorkView[] | undefined
): boolean {
  const ended = journal.newestTurn()?.completedAt
  return (childWork ?? []).some(
    (work) => work.settledAt !== undefined && (ended === undefined || work.settledAt > ended)
  )
}

/** For a caller inside the session's serialize, before it hands the next send to the child. Work
 *  the child still owes keeps it, as it keeps an idle one from the sweep. A stop that fails leaves
 *  the close begun, which the start joins. */
export async function retireSignedOutStructuredAgentSessionChild(
  sessionId: string,
  session: SignedOutReading | undefined,
  deps: {
    work: StructuredAgentSessionChildWorkReads
    stopAgent: (sessionId: string) => Promise<void>
    logger: StructuredAgentSessionLogger
  }
): Promise<void> {
  if (
    !session ||
    !structuredAgentSessionChildReportedSignedOut(session) ||
    structuredAgentSessionChildHasOpenWork(session.journal, deps.work) ||
    owesWakeUp(session.journal, deps.work.childWork())
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
