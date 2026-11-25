import type { ConnectorFailure } from '../../../../shared/connectors/connector-cloud-contract'
import type Database from '../../../sqlite/sync-database'
import type { AgentJournalMessageItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  answersThroughOutbox,
  type JournalConnectorReplyCut,
  type JournalConnectorReplyCutRows,
  type JournalConnectorReplyFill,
  type JournalConnectorReplyKey
} from '../../../../shared/agent-session/journal/journal-connector-reply'

// The reply outbox's writes (design item 125 §2). Each runs on the journal's writer connection,
// inside the command or maintenance transaction that owns the change it follows.

type Target = { sessionId: string; epoch: string }

/** One row per delivery a committed admission takes (its head and each carried id); a repeat keeps
 *  the first. Only Slack's conversations are answered through the outbox. A continuation's
 *  admission claims, in the same transaction, the unclaimed rows its cut owes. */
export function recordJournalConnectorReplies(
  db: Database.Database,
  target: Target,
  messageId: string,
  queued: boolean,
  body: AgentJournalMessageItem
): void {
  claimJournalConnectorReplies(db, target, messageId, body)
  const stamp = body.connectorDelivery
  if (!stamp || !answersThroughOutbox(stamp.conversation.source)) {
    return
  }
  const insert = db.prepare(`INSERT INTO journal_connector_replies
    (account,delivery_id,source,external_id,session_id,epoch,message_id,queued,quiet_rule)
    VALUES(?,?,?,?,?,?,?,?,'trailing') ON CONFLICT(account,delivery_id) DO NOTHING`)
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

// The state a fill expects its row in (JournalConnectorReplyExpect): open, claimed by a message, or
// owed by a cut and unclaimed. A stale writer changes nothing.
const EXPECT_OPEN = 'cut_turn_id IS NULL AND claim_message_id IS NULL'
const EXPECT_CLAIMED = 'claim_message_id=?'
const EXPECT_CUT = 'cut_turn_id=? AND claim_message_id IS NULL'

/** A continuation's admission claims the unclaimed rows its cut owes: those already cut, and the
 *  still open ones its claim names (the cut's own deliveries, which a classification after the
 *  launch would cut). In the admission's transaction. */
export function claimJournalConnectorReplies(
  db: Database.Database,
  target: Target,
  messageId: string,
  body: AgentJournalMessageItem
): void {
  const claim = body.connectorClaim
  if (!claim) {
    return
  }
  const { cutTurnId, cutKind } = claim
  db.prepare(`UPDATE journal_connector_replies SET claim_message_id=?
    WHERE session_id=? AND cut_turn_id=? AND outcome IS NULL AND claim_message_id IS NULL`).run(
    messageId,
    target.sessionId,
    cutTurnId
  )
  const open = db.prepare(`UPDATE journal_connector_replies
    SET claim_message_id=?,cut_turn_id=?,cut_kind=?
    WHERE session_id=? AND account=? AND delivery_id=? AND outcome IS NULL AND ${EXPECT_OPEN}`)
  for (const stamp of claim.origin) {
    for (const deliveryId of [stamp.deliveryId, ...(stamp.carried ?? [])]) {
      open.run(messageId, cutTurnId, cutKind, target.sessionId, stamp.account, deliveryId)
    }
  }
}

/** A queued continuation's card was handed over as a send of its own id: what the card claimed is
 *  that send's, so its turn fills them. In the handover's transaction. */
export function repointJournalConnectorClaim(
  db: Database.Database,
  target: Target,
  cardId: string,
  messageId: string
): void {
  db.prepare(`UPDATE journal_connector_replies SET claim_message_id=?
    WHERE session_id=? AND claim_message_id=? AND outcome IS NULL`).run(
    messageId,
    target.sessionId,
    cardId
  )
}

/** The first fill wins (O7): a row already filled keeps its outcome, and a row in another state than
 *  the fill expects keeps its own. */
export function fillJournalConnectorReplies(
  db: Database.Database,
  fills: readonly JournalConnectorReplyFill[],
  now: number
): number {
  const fillWhere = (expect: string) =>
    db.prepare(`UPDATE journal_connector_replies SET outcome=?,answer_delivery_id=?,
    turn_item_id=?,prose=?,failure_json=?,links_json=?,took_ms=?,turn_started_at=?,tools_ran=?,
    filled_at=? WHERE account=? AND delivery_id=? AND outcome IS NULL AND ${expect}`)
  const open = fillWhere(EXPECT_OPEN)
  const claimed = fillWhere(EXPECT_CLAIMED)
  const owed = fillWhere(EXPECT_CUT)
  let filled = 0
  for (const row of fills) {
    const expect = row.expect
    const [fill, expected] =
      expect === undefined
        ? [open, []]
        : 'claimMessageId' in expect
          ? [claimed, [expect.claimMessageId]]
          : [owed, [expect.cutTurnId]]
    filled += Number(
      fill.run(
        row.outcome,
        row.answerDeliveryId,
        row.turnItemId ?? null,
        row.prose ?? null,
        failureJson(row.failure),
        row.links?.length ? JSON.stringify(row.links) : null,
        row.tookMs ?? null,
        row.turnStartedAt ?? null,
        row.toolsRan ? 1 : null,
        now,
        row.account,
        row.deliveryId,
        ...expected
      ).changes
    )
  }
  return filled
}

const failureJson = (failure: ConnectorFailure | undefined) =>
  failure === undefined ? null : JSON.stringify(failure)

/** Open rows a cut now owes a continuation; a usage-limit cut keeps its failure for its close. */
export function cutJournalConnectorReplies(
  db: Database.Database,
  { keys, cut, failure }: JournalConnectorReplyCutRows
): number {
  const mark =
    db.prepare(`UPDATE journal_connector_replies SET cut_turn_id=?,cut_kind=?,failure_json=?
    WHERE account=? AND delivery_id=? AND outcome IS NULL AND ${EXPECT_OPEN}`)
  let changed = 0
  for (const key of keys) {
    changed += Number(
      mark.run(cut.turnId, cut.kind, failureJson(failure), key.account, key.deliveryId).changes
    )
  }
  return changed
}

/** A continuation's own turn was cut, and a continuation of that cut is owed: the rows it claimed
 *  are that cut's now, claim cleared. A usage-limit cut's own failure replaces the snapshot; a
 *  restart cut keeps the one it found. */
export function recutJournalConnectorReplies(
  db: Database.Database,
  claimMessageId: string,
  cut: JournalConnectorReplyCut,
  failure?: ConnectorFailure
): number {
  return Number(
    db
      .prepare(`UPDATE journal_connector_replies SET cut_turn_id=?,cut_kind=?,claim_message_id=NULL,
        failure_json=COALESCE(?,failure_json) WHERE claim_message_id=? AND outcome IS NULL`)
      .run(cut.turnId, cut.kind, failureJson(failure), claimMessageId).changes
  )
}

/** A claim whose message never became the continuation (refused, or removed by a rewind): its rows
 *  are their cut's again. */
export function releaseJournalConnectorClaim(
  db: Database.Database,
  claimMessageId: string
): number {
  return Number(
    db
      .prepare(`UPDATE journal_connector_replies SET claim_message_id=NULL
        WHERE claim_message_id=? AND outcome IS NULL`)
      .run(claimMessageId).changes
  )
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
    SET outcome='cleared',answer_delivery_id=delivery_id,failure_json=NULL,filled_at=?
    WHERE session_id=? AND epoch=? AND message_id=? AND outcome IS NULL`)
  for (const messageId of new Set(removed)) {
    clear.run(now, target.sessionId, target.epoch, messageId)
  }
  // A continuation the rewind removed holds nothing: its claim goes back to the cut.
  const claims = db
    .prepare(`SELECT DISTINCT claim_message_id FROM journal_connector_replies
      WHERE session_id=? AND claim_message_id IS NOT NULL AND outcome IS NULL`)
    .all(target.sessionId)
    .map((row) => String(row.claim_message_id))
  for (const claim of claims) {
    if (
      db
        .prepare('SELECT 1 FROM journal_rewind_removals WHERE item_id=?')
        .get(agentJournalSubmissionKey(claim)) !== undefined
    ) {
      releaseJournalConnectorClaim(db, claim)
    }
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
    SET outcome='withdrawn',answer_delivery_id=delivery_id,failure_json=NULL,filled_at=?
    WHERE session_id=? AND epoch=? AND message_id=? AND outcome IS NULL`)
  // A withdrawn queued continuation never runs: the rows it claimed are their cut's again.
  const release = db.prepare(`UPDATE journal_connector_replies SET claim_message_id=NULL
    WHERE session_id=? AND epoch=? AND claim_message_id=? AND outcome IS NULL`)
  for (const messageId of messageIds) {
    withdraw.run(now, target.sessionId, target.epoch, messageId)
    release.run(target.sessionId, target.epoch, messageId)
  }
}

/** A deleted chat no longer has its requests: unfilled rows say so; sent rows have nothing left. */
export function forgetJournalConnectorReplies(
  db: Database.Database,
  sessionId: string,
  now: number
): void {
  db.prepare(`UPDATE journal_connector_replies
    SET outcome='not_found',answer_delivery_id=delivery_id,failure_json=NULL,filled_at=?
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
