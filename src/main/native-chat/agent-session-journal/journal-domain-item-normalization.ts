import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalStopSettleFact } from './journal-writer-host-facts'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import { personStopDecidesTurn, turnEndAfterStop } from './context-epochs/journal-stop-turn-end'
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

export function journalDomainStopDecidesTurn(
  stop: JournalLatestStop | null,
  turnId: string | null,
  endedAt?: number
): boolean {
  // The pure Stop policy reads only this mark; collection members are never consulted.
  return personStopDecidesTurn(
    {
      items: new Map(),
      submissions: new Map(),
      aliases: new Map(),
      queuePauseMarks: { latestStop: stop, resumedSequence: 0, reopenedSequence: 0 }
    },
    turnId,
    endedAt
  )
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
  if (body.kind === 'turn' && body.state === 'interrupted' && body.outcome === undefined) {
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
  body = withOpeningSendWrittenAt(db, target, body, previous?.body)
  return boundRunningToolOutput(body)
}

/** A turn keeps its opening send's writtenAt on the record itself, so forks and reloads count from it. */
function withOpeningSendWrittenAt(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  body: AgentJournalItemBody,
  previous: AgentJournalItemBody | undefined
): AgentJournalItemBody {
  if (body.kind !== 'turn' || body.writtenAt !== undefined || !body.userItemId) {
    return body
  }
  const kept = previous?.kind === 'turn' ? previous.writtenAt : undefined
  const writtenAt = kept ?? openingSendWrittenAt(db, target, body.userItemId)
  return writtenAt === undefined ? body : { ...body, writtenAt }
}

function openingSendWrittenAt(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  userItemId: string
): number | undefined {
  const alias = db
    .prepare(
      `SELECT item_id FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=?`
    )
    .get(target.sessionId, target.epoch, userItemId)
  const identity = parseAgentJournalItemKey(alias ? String(alias.item_id) : userItemId)
  if (identity?.provider !== 'orca') {
    return undefined
  }
  const row = db
    .prepare(
      `SELECT json_extract(payload_json,'$.writtenAt') AS written_at FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND message_id=? AND current=1`
    )
    .get(target.sessionId, target.epoch, identity.clientMessageId)
  const writtenAt = Number(row?.written_at)
  return Number.isFinite(writtenAt) && writtenAt > 0 ? writtenAt : undefined
}
