// Key Stop notes by captured turn so repeated Stops revise one row, even after the turn ends.

import type { AgentJournalTurnScope } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'
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
