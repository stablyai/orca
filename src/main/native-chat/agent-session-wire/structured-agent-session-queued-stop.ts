// A Stop's event and the queue. A Stop never withdraws a draft and no text ever
// travels back over the wire: it is accepted with ONE Stop event (`JournalStopEvent`), withdrawing
// every queued send in the same transaction (`journal-stop-acceptance.ts`), and the queue's
// pause is derived from that event (`queued-message-pause.ts`) until any turn is sent after it and
// accepted, or the person Resumes. The cards stay published, and Send-now sends one card without
// lifting the pause for the rest until that card's turn starts.

import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../agent-session-journal/queued-message-table'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { isMainAgentWorking } from './structured-agent-session-turns-cancel'
import {
  structuredAgentSessionStopNamesEndedTurn,
  structuredAgentSessionStopNamesTurnNotLive
} from './structured-agent-session-turn-stop-notes'

/** The one unsettled-card predicate /clear's carry and the published-bytes bound share:
 *  waiting or returned. Pending/unknown/accepted deliveries stay outside it. */
export function unsettledQueuedMessages(journal: AgentSessionJournal): QueuedMessageRow[] {
  return journal.queuedMessages.list().filter(isUnsettledQueuedMessage)
}

/**
 * What a Stop reaching a running agent stops: work no Stop event records yet (`unrecorded`), or
 * only what the Stop still in force already records, which it repeats with nothing sent since, on
 * the same turn or one that opened after a Stop pressed before any turn showed (`repeat`): a card
 * queued between the presses then sends normally, as after one Stop. `late`: it names a turn the
 * journal shows already over, as a late Stop from a phone can, even while the next send is handed
 * over; only a turn with no row yet may still be opening.
 */
export function stopReachesUnrecordedWork(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence'>,
  namedTurnId: string | undefined
): 'unrecorded' | 'repeat' | 'late' {
  if (structuredAgentSessionStopNamesEndedTurn(ctx.journal, namedTurnId, isMainAgentWorking(ctx))) {
    return 'late'
  }
  const live = ctx.journal.activeTurnId()
  const inForce = ctx.journal.queuedMessages.userStopInForce()
  if (inForce === null) {
    return 'unrecorded'
  }
  // This interrupt may send a later send back to waiting, so this Stop must hold it.
  return sentSinceStop(ctx.journal, inForce) ||
    structuredAgentSessionStopNamesTurnNotLive(inForce.event.turnId, live)
    ? 'unrecorded'
    : 'repeat'
}

/** Whether anything was sent after the Stop in force and not refused, even if its fate is
 *  unknown. A send with no sequence is an older host's. */
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
