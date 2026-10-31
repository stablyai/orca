// Key Stop notes by captured turn so repeated Stops revise one row, even after the turn ends.

import type {
  AgentJournalStatusItem,
  AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
import type { structuredAgentSessionStopNoteIdentity } from './structured-agent-session-command-turn'
import type { StructuredAgentSessionLogger } from './structured-agent-session-logger'
import type { StructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

export const STOP_NOTE_CANCELLATION_REQUESTED = 'Cancellation requested.'

export function structuredAgentSessionStoppedTurnId(
  work: Pick<StructuredAgentSessionCurrentWork, 'activeTurnId'>,
  namedTurnId: string | undefined
): string | null {
  return namedTurnId ?? work.activeTurnId()
}

export function structuredAgentSessionStopNamesTurnNotLive(
  namedTurnId: string | undefined,
  liveTurnId: string | null
): boolean {
  return namedTurnId !== undefined && namedTurnId !== liveTurnId
}

/** A known non-live turn is ended, including one removed by rewind; unknown turns may still open. */
export function structuredAgentSessionStopNamesEndedTurn(
  journal: Pick<AgentSessionJournal, 'snapshot' | 'stops'>,
  work: Pick<StructuredAgentSessionCurrentWork, 'activeTurnId' | 'working'>,
  namedTurnId: string | undefined
): boolean {
  const live = work.activeTurnId()
  if (namedTurnId === undefined || namedTurnId === live) {
    return false
  }
  return (
    live !== null ||
    !work.working() ||
    journal.stops.turnWasRemoved(namedTurnId) ||
    structuredAgentSessionNamedTurnScope(journal, namedTurnId) !== null
  )
}

export function structuredAgentSessionNamedTurnScope(
  journal: Pick<AgentSessionJournal, 'snapshot'>,
  turnId: string
): Extract<AgentJournalTurnScope, { kind: 'turn' }> | null {
  const turn = journal
    .snapshot()
    .items.findLast((item) => readAgentJournalTurn(item.body)?.turnId === turnId)
  return turn ? { kind: 'turn', turnItemId: turn.itemId } : null
}

/** The turn the provider says the interrupt took, even one that opened while the cancel waited for
 *  it: the note is that turn's, never a conversation row read before the wait. */
export function structuredAgentSessionStopNoteScope(
  journal: Pick<AgentSessionJournal, 'snapshot'>,
  stoppedTurn: string | undefined,
  fallback: AgentJournalTurnScope
): AgentJournalTurnScope {
  return (
    (stoppedTurn !== undefined
      ? structuredAgentSessionNamedTurnScope(journal, stoppedTurn)
      : null) ?? fallback
  )
}

export function writeStructuredAgentSessionStopNote(
  ctx: {
    journal: AgentSessionJournal
    fence: number
    logger: StructuredAgentSessionLogger
    sessionId: string
  },
  input: {
    identity: ReturnType<typeof structuredAgentSessionStopNoteIdentity>
    body: AgentJournalStatusItem
    stoppedTurn?: string
    fallbackScope: AgentJournalTurnScope
  }
): Promise<void> {
  return ctx.journal
    .appendItem(input.identity, input.body, {
      fence: ctx.fence,
      turnScope: structuredAgentSessionStopNoteScope(
        ctx.journal,
        input.stoppedTurn,
        input.fallbackScope
      )
    })
    .then(() => undefined)
    .catch((error: unknown) =>
      ctx.logger.warn('writing the Stop note failed', {
        scope: 'chat-stop-note',
        sessionId: ctx.sessionId,
        error
      })
    )
}
