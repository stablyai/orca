import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import type { QueuedMessageRow, QueuedMessageState } from './queued-messages/queued-message-table'

type Target = { sessionId: string; epoch: string }

/** The current card and the content/state revision an edit hold or replacement addresses. */
export type JournalDomainQueueRow = { card: QueuedMessageRow; revision: number }

export const SELECT_JOURNAL_DOMAIN_QUEUE_ROW = `SELECT message_id, revision, state, position,
  payload_json FROM journal_queue_cards`

export function readJournalDomainQueueRow(
  sessionId: string,
  row: SqliteRow
): JournalDomainQueueRow {
  const card: QueuedMessageRow = JSON.parse(String(row.payload_json))
  return {
    card: {
      ...card,
      messageId: String(row.message_id),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the state column is only ever written from a QueuedMessageRow state.
      state: String(row.state) as QueuedMessageState,
      position: Number(row.position),
      fingerprint: agentSessionSendBodyFingerprint(sessionId, card.body)
    },
    revision: Number(row.revision)
  }
}

export function journalDomainQueueRow(
  db: Database.Database,
  target: Target,
  messageId: string
): JournalDomainQueueRow | null {
  const row = db
    .prepare(`${SELECT_JOURNAL_DOMAIN_QUEUE_ROW} WHERE session_id=? AND epoch=? AND message_id=?`)
    .get(target.sessionId, target.epoch, messageId)
  return row ? readJournalDomainQueueRow(target.sessionId, row) : null
}

/** Whether an attempt admitted from this selected current card counts as the person's own input. */
export function journalDomainAdmittedPersonal(
  card: Pick<QueuedMessageRow, 'body' | 'unattended'>
): boolean {
  return card.unattended !== true && card.body.from === undefined
}

function commandTurnItemId(card: QueuedMessageRow): string | null {
  return card.state === 'returned' && card.body.command && card.consumedAs !== null
    ? agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(card.consumedAs))
    : null
}

function payload(card: QueuedMessageRow): string {
  const {
    messageId: _id,
    position: _position,
    state: _state,
    fingerprint: _derived,
    ...rest
  } = card
  return JSON.stringify(rest)
}

export function insertJournalDomainQueueRow(
  db: Database.Database,
  target: Target,
  card: QueuedMessageRow
): void {
  db.prepare(`INSERT INTO journal_queue_cards(session_id,epoch,message_id,revision,state,position,
      command_turn_item_id,payload_json) VALUES(?,?,?,1,?,?,?,?)`).run(
    target.sessionId,
    target.epoch,
    card.messageId,
    card.state,
    card.position,
    commandTurnItemId(card),
    payload(card)
  )
}

/** Rewrites content or state in place; the next revision ends edit holds on the addressed one. */
export function replaceJournalDomainQueueRow(
  db: Database.Database,
  target: Target,
  prior: JournalDomainQueueRow,
  card: QueuedMessageRow
): void {
  if (prior.card.messageId !== card.messageId || prior.card.position !== card.position) {
    throw new Error('journal queue replacement must keep its card and placement')
  }
  const replaced = db
    .prepare(`UPDATE journal_queue_cards SET revision=revision+1, state=?, command_turn_item_id=?,
      payload_json=? WHERE session_id=? AND epoch=? AND message_id=? AND revision=?`)
    .run(
      card.state,
      commandTurnItemId(card),
      payload(card),
      target.sessionId,
      target.epoch,
      card.messageId,
      prior.revision
    )
  if (replaced.changes !== 1) {
    throw new Error('journal queue card was already replaced')
  }
}

/** A hold reason is neither content nor state, so edit holds survive it. */
export function holdJournalDomainQueueRow(
  db: Database.Database,
  target: Target,
  prior: JournalDomainQueueRow,
  holdReason: string | null
): void {
  db.prepare(`UPDATE journal_queue_cards SET payload_json=json_set(payload_json,'$.holdReason',?)
    WHERE session_id=? AND epoch=? AND message_id=? AND revision=?`).run(
    holdReason,
    target.sessionId,
    target.epoch,
    prior.card.messageId,
    prior.revision
  )
}

/** Placement only: no body, revision or edit hold changes. */
export function placeJournalDomainQueueRow(
  db: Database.Database,
  target: Target,
  messageId: string,
  position: number
): void {
  db.prepare(`UPDATE journal_queue_cards SET position=?
    WHERE session_id=? AND epoch=? AND message_id=? AND state IN ('waiting','returned')`).run(
    position,
    target.sessionId,
    target.epoch,
    messageId
  )
}
