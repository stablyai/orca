// Stop atomically records its event/queued-send withdrawal without withdrawing draft text.
// Derive pause until a later send’s turn starts or Resume; Send-now alone lifts only its own card.

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import {
  structuredAgentSessionStopNamesEndedTurn,
  structuredAgentSessionStopNamesTurnNotLive
} from './structured-agent-session-turn-stop-notes'

/** Unsettled means waiting/returned; pending, unknown and accepted deliveries are excluded. */
export function unsettledQueuedMessages(journal: AgentSessionJournal): QueuedMessageRow[] {
  return journal.queuedMessages.list().filter(isUnsettledQueuedMessage)
}

/** Distinguish unrecorded work, repeated Stop without later sends, and late Stops naming ended turns. */
export function stopReachesUnrecordedWork(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork'>,
  namedTurnId: string | undefined
): 'unrecorded' | 'repeat' | 'late' {
  const work = contextStructuredAgentSessionCurrentWork(ctx)
  if (structuredAgentSessionStopNamesEndedTurn(ctx.journal, work, namedTurnId)) {
    return 'late'
  }
  const live = work.activeTurnId()
  const inForce = ctx.journal.queuedMessages.userStopInForce()
  if (inForce === null) {
    return 'unrecorded'
  }
  // This interrupt may return later sends to waiting, so it must hold them.
  return sentSinceStop(ctx.journal, inForce) ||
    structuredAgentSessionStopNamesTurnNotLive(inForce.event.turnId, live)
    ? 'unrecorded'
    : 'repeat'
}

/** Include nonrefused later sends even if unknown; missing sequence is legacy data. */
export function sentSinceStop(
  journal: Pick<AgentSessionJournal, 'submissions'>,
  inForce: { sequence: number }
): boolean {
  return journal
    .submissions()
    .some(
      (entry) =>
        entry.dispatchState !== 'rejected' &&
        entry.acceptedSequence !== undefined &&
        entry.acceptedSequence > inForce.sequence
    )
}
