// Stop atomically records its event/queued-send withdrawal without withdrawing draft text.
// Derive pause until a later send’s turn starts or Resume; Send-now alone lifts only its own card.

import type { SqlAgentSessionJournal as AgentSessionJournal } from '../../agent-session-journal/journal-sql-store'
import {
  isUnsettledQueuedMessage,
  type QueuedMessageRow
} from '../../agent-session-journal/queued-messages/queued-message-table'
import type { AgentSessionTurnContext } from '../operations/structured-agent-session-turns'
import { readContextStructuredAgentSessionTurn } from '../observations/structured-agent-session-read-work'
import {
  structuredAgentSessionStopNamesEndedTurn,
  structuredAgentSessionStopNamesTurnNotLive
} from '../termination/structured-agent-session-turn-stop-notes'

/** Unsettled means waiting/returned; pending, unknown and accepted deliveries are excluded. */
export async function unsettledQueuedMessages(
  journal: AgentSessionJournal
): Promise<QueuedMessageRow[]> {
  return (await journal.queuedMessages.list()).filter(isUnsettledQueuedMessage)
}

/** Distinguish unrecorded work, repeated Stop without later sends, and late Stops naming ended turns. */
export async function stopReachesUnrecordedWork(
  ctx: Pick<AgentSessionTurnContext, 'journal' | 'fence' | 'currentWork' | 'readWork'>,
  namedTurnId: string | undefined
): Promise<'unrecorded' | 'repeat' | 'late'> {
  const { activeTurnId: live, working } = await readContextStructuredAgentSessionTurn(ctx)
  const work = { activeTurnId: () => live, working: () => working }
  if (await structuredAgentSessionStopNamesEndedTurn(ctx.journal, work, namedTurnId)) {
    return 'late'
  }
  const inForce = await Promise.resolve(ctx.journal.queuedMessages.userStopInForce())
  if (inForce === null) {
    return 'unrecorded'
  }
  // This interrupt may return later sends to waiting, so it must hold them.
  return (await sentSinceStop(ctx.journal, inForce)) ||
    structuredAgentSessionStopNamesTurnNotLive(inForce.event.turnId, live)
    ? 'unrecorded'
    : 'repeat'
}

/** Include nonrefused later sends even if unknown; missing sequence is legacy data. */
export async function sentSinceStop(
  journal: Pick<AgentSessionJournal, 'reads'>,
  inForce: { sequence: number }
): Promise<boolean> {
  return (await journal.reads.input({ kind: 'sent-after', sequence: inForce.sequence })).answer
}
