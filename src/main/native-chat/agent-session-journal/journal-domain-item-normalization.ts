import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import {
  personStopDecidesFailure,
  personStopDecidesTurn,
  turnEndAfterStop,
  turnEndStopMayDecide
} from './context-epochs/journal-stop-turn-end'
import { boundRunningToolOutput } from './item-lifecycle/journal-payload-bounds'
import { isAdmissibleAgentSessionContextUsage } from '../../../shared/agent-session/conversation-context/agent-session-context-usage-schema'

export function journalDomainLatestStop(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  stopSettle?: JournalStopSettleFact
): JournalLatestStop | null {
  const row = db
    .prepare(`SELECT queue_latest_stop_json FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(target.sessionId, target.epoch)
  const stop: JournalLatestStop | null =
    row?.queue_latest_stop_json == null ? null : JSON.parse(String(row.queue_latest_stop_json))
  if (!stop) {
    return null
  }
  const { settle: _savedOverlay, ...saved } = stop
  return stopSettle?.sequence === stop.sequence ? { ...saved, settle: stopSettle.settle } : saved
}

// The pure Stop policy reads only this mark; collection members are never consulted.
const stopOnly = (stop: JournalLatestStop | null) => ({
  items: new Map(),
  submissions: new Map(),
  aliases: new Map(),
  queuePauseMarks: { latestStop: stop, resumedSequence: 0, reopenedSequence: 0 }
})

export function journalDomainStopDecidesTurn(
  stop: JournalLatestStop | null,
  turnId: string | null,
  endedAt?: number
): boolean {
  return personStopDecidesTurn(stopOnly(stop), turnId, endedAt)
}

/** personStopDecidesFailure over the saved Stop alone. */
export function journalDomainStopDecidesFailure(
  stop: JournalLatestStop | null,
  turnId: string,
  endedAt: number
): boolean {
  return personStopDecidesFailure(stopOnly(stop), turnId, endedAt)
}

/** Every current-item owner applies the same bounded body and write-time Stop policy. */
export function normalizeJournalDomainItemBody(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  item: AgentJournalRenderItem,
  previous: AgentJournalRenderItem | undefined,
  stopSettle?: JournalStopSettleFact
): AgentJournalItemBody {
  let body = item.body
  if (
    body.kind === 'turn' &&
    body.contextUsage !== undefined &&
    !isAdmissibleAgentSessionContextUsage(body.contextUsage)
  ) {
    const { contextUsage: _unusable, ...usable } = body
    body = usable
  }
  if (turnEndStopMayDecide(body)) {
    const latestStop = journalDomainLatestStop(db, target, stopSettle)
    // A one-row policy input is temporary command data, never a reconstructed session.
    body = turnEndAfterStop(
      {
        items: new Map(previous ? [[item.itemId, previous]] : []),
        submissions: new Map(),
        aliases: new Map(),
        queuePauseMarks: { latestStop, resumedSequence: 0, reopenedSequence: 0 }
      },
      item.itemId,
      body
    )
  }
  return boundRunningToolOutput(body)
}
