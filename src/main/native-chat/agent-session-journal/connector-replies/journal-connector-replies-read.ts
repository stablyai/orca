import type Database from '../../../sqlite/sync-database'
import {
  JOURNAL_CONNECTOR_REPLY_OUTCOMES,
  JOURNAL_CONNECTOR_REPLY_PROSE_BYTES,
  type JournalConnectorReplyRow
} from '../../../../shared/agent-session/journal/journal-connector-reply'

// The reply outbox's reads (design item 125 §3), on the journal's reader workers.

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
  return rows.map(replyRowOf)
}

// Every column a row reads but prose, which a page reads bounded.
const OWED_COLUMNS = `account,delivery_id,source,external_id,session_id,epoch,message_id,queued,
  outcome,answer_delivery_id,turn_item_id,failure_json,links_json,took_ms,turn_started_at,filled_at,cut_turn_id,
  cut_kind,claim_message_id`

/** One page of an account's filled, unsent rows after a delivery id, in key order: what the outbox
 *  sends. Paged so a backlog never outgrows one reader reply. A prose over the cap (kept whole by
 *  an older build) comes cut to one character past it, so the sender still sees it as too long and
 *  cuts it the rest of the way, with its note. */
export function readOwedJournalConnectorReplies(
  db: Database.Database,
  account: string,
  after: string | null,
  limit: number
): JournalConnectorReplyRow[] {
  return db
    .prepare(`SELECT ${OWED_COLUMNS},
      CASE WHEN octet_length(prose)>? THEN substr(prose,1,?) ELSE prose END AS prose
      FROM journal_connector_replies
      WHERE account=? AND (? IS NULL OR delivery_id>?) AND outcome IS NOT NULL AND sent_at IS NULL
      ORDER BY delivery_id LIMIT ?`)
    .all(
      JOURNAL_CONNECTOR_REPLY_PROSE_BYTES,
      JOURNAL_CONNECTOR_REPLY_PROSE_BYTES + 1,
      account,
      after,
      after,
      limit
    )
    .map(replyRowOf)
}

function replyRowOf(row: Record<string, unknown>): JournalConnectorReplyRow {
  const outcome = JOURNAL_CONNECTOR_REPLY_OUTCOMES.find((known) => known === row.outcome)
  return {
    account: String(row.account),
    deliveryId: String(row.delivery_id),
    conversation: { source: String(row.source), externalId: String(row.external_id) },
    sessionId: String(row.session_id),
    epoch: String(row.epoch),
    messageId: String(row.message_id),
    queued: Number(row.queued) === 1,
    ...(row.cut_turn_id === null || row.cut_turn_id === undefined
      ? {}
      : {
          cut: {
            turnId: String(row.cut_turn_id),
            kind: row.cut_kind === 'usage_limit' ? ('usage_limit' as const) : ('restart' as const)
          }
        }),
    ...(row.claim_message_id === null || row.claim_message_id === undefined
      ? {}
      : { claimMessageId: String(row.claim_message_id) }),
    // An unfilled row's failure is its usage-limit cut's, kept for that cut's close.
    ...(outcome === undefined && row.failure_json !== null && row.failure_json !== undefined
      ? { cutFailure: JSON.parse(String(row.failure_json)) }
      : {}),
    ...(outcome === undefined
      ? {}
      : {
          fill: {
            outcome,
            answerDeliveryId: String(row.answer_delivery_id),
            ...(row.turn_item_id === null ? {} : { turnItemId: String(row.turn_item_id) }),
            ...(row.prose === null ? {} : { prose: String(row.prose) }),
            ...(row.failure_json === null ? {} : { failure: JSON.parse(String(row.failure_json)) }),
            ...(row.links_json === null ? {} : { links: JSON.parse(String(row.links_json)) }),
            ...(row.took_ms === null || row.took_ms === undefined
              ? {}
              : { tookMs: Number(row.took_ms) }),
            ...(row.turn_started_at === null || row.turn_started_at === undefined
              ? {}
              : { turnStartedAt: Number(row.turn_started_at) }),
            filledAt: Number(row.filled_at)
          }
        })
  }
}
