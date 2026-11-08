import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import { structuredAgentSessionCommandTurnIdentity } from '../../../shared/agent-session/view/structured-agent-session-command-turn-identity'
import type { QueuedMessageRow, QueuedMessageState } from './queued-messages/queued-message-table'

type Target = { sessionId: string; epoch: string }

/** A current card with the version key a replacement must address. */
export type JournalDomainCard = {
  card: QueuedMessageRow
  version: { sequence: number; index: number }
}

export const SELECT_JOURNAL_DOMAIN_CARD = `SELECT message_id, version_sequence, version_index,
  state, position, payload_json FROM journal_card_versions`

export function readJournalDomainCard(sessionId: string, row: SqliteRow): JournalDomainCard {
  const card: QueuedMessageRow = JSON.parse(String(row.payload_json))
  const position = row.position === null ? card.position : Number(row.position)
  return {
    card: {
      ...card,
      messageId: String(row.message_id),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the state column is only ever written from a QueuedMessageRow state.
      state: String(row.state) as QueuedMessageState,
      position,
      fingerprint: agentSessionSendBodyFingerprint(sessionId, card.body)
    },
    version: { sequence: Number(row.version_sequence), index: Number(row.version_index) }
  }
}

export function journalDomainCurrentCard(
  db: Database.Database,
  target: Target,
  messageId: string
): JournalDomainCard | null {
  const row = db
    .prepare(
      `${SELECT_JOURNAL_DOMAIN_CARD} WHERE session_id=? AND epoch=? AND message_id=? AND current=1`
    )
    .get(target.sessionId, target.epoch, messageId)
  return row ? readJournalDomainCard(target.sessionId, row) : null
}

function commandTurnItemId(card: QueuedMessageRow): string | null {
  return card.state === 'returned' && card.body.command && card.consumedAs !== null
    ? agentJournalItemKey(structuredAgentSessionCommandTurnIdentity(card.consumedAs))
    : null
}

/**
 * Copy-replaces the addressed current version with `card` at (sequence, 0). The replaced version
 * stays only while a submission attempt names it as its source; it is never rewritten.
 */
export function writeJournalDomainCardVersion(
  db: Database.Database,
  target: Target,
  prior: JournalDomainCard | null,
  card: QueuedMessageRow,
  sequence: number
): void {
  const prefix = [target.sessionId, target.epoch] as const
  if (prior) {
    if (prior.card.messageId !== card.messageId || prior.version.sequence >= sequence) {
      throw new Error('journal card version must follow its addressed prior version')
    }
    const key = [card.messageId, prior.version.sequence, prior.version.index] as const
    const replaced = db
      .prepare(`UPDATE journal_card_versions SET current=0 WHERE session_id=? AND epoch=?
        AND message_id=? AND version_sequence=? AND version_index=? AND current=1`)
      .run(...prefix, ...key)
    if (replaced.changes !== 1) {
      throw new Error('journal card version was already replaced')
    }
    db.prepare(`DELETE FROM journal_card_versions WHERE session_id=? AND epoch=?
      AND message_id=? AND version_sequence=? AND version_index=?
      AND NOT EXISTS(SELECT 1 FROM journal_submission_attempts AS attempt
        WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.source_card_sequence=?
          AND attempt.source_card_index=? AND json_extract(attempt.payload_json,'$.queuedMessageId')=?)`).run(
      ...prefix,
      ...key,
      ...prefix,
      prior.version.sequence,
      prior.version.index,
      card.messageId
    )
  }
  const { fingerprint: _derived, ...payload } = card
  db.prepare(`INSERT INTO journal_card_versions(session_id,epoch,message_id,version_sequence,
      version_index,current,state,command_turn_item_id,payload_json,position)
    VALUES(?,?,?,?,0,1,?,?,?,?)`).run(
    ...prefix,
    card.messageId,
    sequence,
    card.state,
    commandTurnItemId(card),
    JSON.stringify(payload),
    card.position
  )
}
