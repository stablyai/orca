import type Database from '../../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  JOURNAL_CONNECTOR_REPLY_OUTCOMES,
  type JournalConnectorReplyFill,
  type JournalConnectorReplyKey,
  type JournalConnectorReplyRow
} from '../../../../shared/agent-session/journal/journal-connector-reply'

// The reply outbox's writes (design item 125 §2). Each runs on the journal's writer connection,
// inside the command or maintenance transaction that owns the change it follows.

type Target = { sessionId: string; epoch: string }

/** One row per delivery a committed admission takes (its head and each carried id); a repeat keeps
 *  the first. Only Slack's conversations are answered through the outbox. */
export function recordJournalConnectorReplies(
  db: Database.Database,
  target: Target,
  messageId: string,
  queued: boolean,
  body: AgentJournalMessageItem
): void {
  const stamp = body.connectorDelivery
  if (!stamp || stamp.conversation.source !== 'slack') {
    return
  }
  const insert = db.prepare(`INSERT INTO journal_connector_replies
    (account,delivery_id,source,external_id,session_id,epoch,message_id,queued)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account,delivery_id) DO NOTHING`)
  for (const deliveryId of [stamp.deliveryId, ...(stamp.carried ?? [])]) {
    insert.run(
      stamp.account,
      deliveryId,
      stamp.conversation.source,
      stamp.conversation.externalId,
      target.sessionId,
      target.epoch,
      messageId,
      Number(queued)
    )
  }
}

/** The first fill wins (O7): a row already filled keeps its outcome. */
export function fillJournalConnectorReplies(
  db: Database.Database,
  fills: readonly JournalConnectorReplyFill[],
  now: number
): number {
  const fill = db.prepare(`UPDATE journal_connector_replies SET outcome=?,answer_delivery_id=?,
    turn_item_id=?,prose=?,failure_json=?,links_json=?,filled_at=?
    WHERE account=? AND delivery_id=? AND outcome IS NULL`)
  let filled = 0
  for (const row of fills) {
    filled += Number(
      fill.run(
        row.outcome,
        row.answerDeliveryId,
        row.turnItemId ?? null,
        row.prose ?? null,
        row.failure === undefined ? null : JSON.stringify(row.failure),
        row.links?.length ? JSON.stringify(row.links) : null,
        now,
        row.account,
        row.deliveryId
      ).changes
    )
  }
  return filled
}

/** A rewind's removal transaction: requests whose message it removed were cleared before their
 *  answer, so they say so. Their removed items are listed in journal_rewind_removals. */
export function clearRewoundJournalConnectorReplies(
  db: Database.Database,
  target: Target,
  now: number
): void {
  const removed = db
    .prepare(`SELECT message_id FROM journal_connector_replies
      WHERE session_id=? AND epoch=? AND outcome IS NULL`)
    .all(target.sessionId, target.epoch)
    .map((row) => String(row.message_id))
    .filter(
      (messageId) =>
        db
          .prepare('SELECT 1 FROM journal_rewind_removals WHERE item_id=?')
          .get(agentJournalSubmissionKey(messageId)) !== undefined
    )
  const clear = db.prepare(`UPDATE journal_connector_replies
    SET outcome='cleared',answer_delivery_id=delivery_id,filled_at=?
    WHERE session_id=? AND epoch=? AND message_id=? AND outcome IS NULL`)
  for (const messageId of new Set(removed)) {
    clear.run(now, target.sessionId, target.epoch, messageId)
  }
}

/** A queue-withdraw transaction: requests whose cards it withdrew were never run. */
export function withdrawJournalConnectorReplies(
  db: Database.Database,
  target: Target,
  messageIds: readonly string[],
  now: number
): void {
  const withdraw = db.prepare(`UPDATE journal_connector_replies
    SET outcome='withdrawn',answer_delivery_id=delivery_id,filled_at=?
    WHERE session_id=? AND epoch=? AND message_id=? AND outcome IS NULL`)
  for (const messageId of messageIds) {
    withdraw.run(now, target.sessionId, target.epoch, messageId)
  }
}

/** A deleted chat no longer has its requests: unfilled rows say so; sent rows have nothing left. */
export function forgetJournalConnectorReplies(
  db: Database.Database,
  sessionId: string,
  now: number
): void {
  db.prepare(`UPDATE journal_connector_replies
    SET outcome='not_found',answer_delivery_id=delivery_id,filled_at=?
    WHERE session_id=? AND outcome IS NULL`).run(now, sessionId)
  db.prepare(
    'DELETE FROM journal_connector_replies WHERE session_id=? AND sent_at IS NOT NULL'
  ).run(sessionId)
}

/** The cloud accepted these rows: marked sent, then gone. */
export function sentJournalConnectorReplies(
  db: Database.Database,
  keys: readonly JournalConnectorReplyKey[],
  now: number
): void {
  const mark = db.prepare(`UPDATE journal_connector_replies SET sent_at=?
    WHERE account=? AND delivery_id=? AND outcome IS NOT NULL`)
  const remove = db.prepare(`DELETE FROM journal_connector_replies
    WHERE account=? AND delivery_id=? AND sent_at IS NOT NULL`)
  for (const key of keys) {
    mark.run(now, key.account, key.deliveryId)
    remove.run(key.account, key.deliveryId)
  }
}

/** Rows not yet accepted: unfilled, or filled and unsent; one session's, or every one. */
export function readJournalConnectorReplies(
  db: Database.Database,
  sessionId?: string
): JournalConnectorReplyRow[] {
  const rows =
    sessionId === undefined
      ? db.prepare('SELECT * FROM journal_connector_replies WHERE sent_at IS NULL').all()
      : db
          .prepare('SELECT * FROM journal_connector_replies WHERE session_id=? AND sent_at IS NULL')
          .all(sessionId)
  return rows.map((row) => {
    const outcome = JOURNAL_CONNECTOR_REPLY_OUTCOMES.find((known) => known === row.outcome)
    return {
      account: String(row.account),
      deliveryId: String(row.delivery_id),
      conversation: { source: String(row.source), externalId: String(row.external_id) },
      sessionId: String(row.session_id),
      epoch: String(row.epoch),
      messageId: String(row.message_id),
      queued: Number(row.queued) === 1,
      ...(outcome === undefined
        ? {}
        : {
            fill: {
              outcome,
              answerDeliveryId: String(row.answer_delivery_id),
              ...(row.turn_item_id === null ? {} : { turnItemId: String(row.turn_item_id) }),
              ...(row.prose === null ? {} : { prose: String(row.prose) }),
              ...(row.failure_json === null
                ? {}
                : { failure: JSON.parse(String(row.failure_json)) }),
              ...(row.links_json === null ? {} : { links: JSON.parse(String(row.links_json)) }),
              filledAt: Number(row.filled_at)
            }
          })
    }
  })
}
