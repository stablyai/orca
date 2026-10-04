// The turn a Stop is about, read once for its event and its note. The note sits on that turn, found
// by the turn's id whether it still runs or has ended, and keyed by it, so a repeated Stop rewrites
// the one row instead of adding one.

import type { AgentJournalTurnScope } from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

export const STOP_NOTE_CANCELLATION_REQUESTED = 'Cancellation requested.'

/** The turn a Stop is about: the one it named, else the one running when it is read. */
export function structuredAgentSessionStoppedTurnId(
  journal: Pick<AgentSessionJournal, 'activeTurnId'>,
  namedTurnId: string | undefined
): string | null {
  return namedTurnId ?? journal.activeTurnId()
}

/** A Stop names a turn the journal does not show running, as a phone does once that turn ended. */
export function structuredAgentSessionStopNamesTurnNotLive(
  namedTurnId: string | undefined,
  liveTurnId: string | null
): boolean {
  return namedTurnId !== undefined && namedTurnId !== liveTurnId
}

/** The scope of the turn `turnId` names, running or ended; null when the journal has no such turn. */
export function structuredAgentSessionNamedTurnScope(
  journal: Pick<AgentSessionJournal, 'snapshot'>,
  turnId: string
): Extract<AgentJournalTurnScope, { kind: 'turn' }> | null {
  const turn = journal
    .snapshot()
    .items.findLast((item) => readAgentJournalTurn(item.body)?.turnId === turnId)
  return turn ? { kind: 'turn', turnItemId: turn.itemId } : null
}
