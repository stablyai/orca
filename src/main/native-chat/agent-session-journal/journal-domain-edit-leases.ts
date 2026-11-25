import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { AgentSessionQueuedMessageEditHoldResult } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import type { AgentJournalMessageItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  QUEUED_MESSAGE_EDIT_LEASE_MS,
  type EditLeaseKey
} from './queued-messages/queued-message-edit-leases'

type Target = { sessionId: string; epoch: string }
export type JournalDomainEditLeaseOperation =
  | ({ kind: 'acquire'; messageId: string; fingerprint: string } & EditLeaseKey)
  | ({ kind: 'renew'; messageId: string } & EditLeaseKey)
  | ({ kind: 'release'; messageId: string } & EditLeaseKey)
  | { kind: 'retire-card'; messageId: string }
  | { kind: 'release-owner' | 'expire' }

export type JournalDomainEditLeaseOutcome = {
  result: AgentSessionQueuedMessageEditHoldResult | null
  changed: boolean
  nextDeadline: number | null
}

/** A hold lives while its card is unsettled at the content/state revision it was taken on. */
const LIVE_CARD = `card.session_id=lease.session_id AND card.epoch=lease.epoch
  AND card.message_id=lease.message_id AND card.revision=lease.card_revision
  AND card.state IN ('waiting','returned')`

const LIVE_HOLDS = `FROM journal_edit_leases AS lease JOIN journal_queue_cards AS card ON ${LIVE_CARD}
WHERE lease.session_id=? AND lease.epoch=? AND lease.expires_at>?`

function requireWallClock(now: number): void {
  if (!Number.isFinite(now)) {
    throw new Error('edit lease requires finite wall-clock milliseconds')
  }
}

export function journalDomainMessageEditHeld(
  db: Database.Database,
  target: Target,
  messageId: string,
  now: number
): boolean {
  requireWallClock(now)
  return (
    db
      .prepare(`SELECT 1 ${LIVE_HOLDS} AND lease.message_id=? LIMIT 1`)
      .get(target.sessionId, target.epoch, now, messageId) !== undefined
  )
}

export function journalDomainHeldMessageIds(
  db: Database.Database,
  target: Target,
  now: number
): string[] {
  requireWallClock(now)
  return db
    .prepare(`SELECT lease.message_id ${LIVE_HOLDS}
      GROUP BY lease.message_id ORDER BY MIN(lease.expires_at), lease.message_id`)
    .all(target.sessionId, target.epoch, now)
    .map((row) => String(row.message_id))
}

export function journalDomainEditLeaseDeadline(
  db: Database.Database,
  target: Target,
  now: number
): number | null {
  requireWallClock(now)
  const row = db
    .prepare(`SELECT MIN(lease.expires_at) AS deadline ${LIVE_HOLDS}`)
    .get(target.sessionId, target.epoch, now)
  return row?.deadline === null || row?.deadline === undefined ? null : Number(row.deadline)
}

/** Content, state or consumed-attempt changes end every hold on these cards. */
export function retireJournalDomainEditHolds(
  db: Database.Database,
  target: Target,
  messageIds: readonly string[]
): boolean {
  const retire = db.prepare(
    'DELETE FROM journal_edit_leases WHERE session_id=? AND epoch=? AND message_id=?'
  )
  let changed = false
  for (const messageId of new Set(messageIds)) {
    changed = retire.run(target.sessionId, target.epoch, messageId).changes > 0 || changed
  }
  return changed
}

function deletePair(db: Database.Database, target: Target, ownerId: string, key: EditLeaseKey) {
  return (
    db
      .prepare(`DELETE FROM journal_edit_leases
        WHERE session_id=? AND epoch=? AND owner_id=? AND caller_key=? AND edit_id=?`)
      .run(target.sessionId, target.epoch, ownerId, key.callerKey, key.editId).changes > 0
  )
}

function bodyFingerprint(target: Target, row: SqliteRow): string {
  const card: { body: AgentJournalMessageItem } = JSON.parse(String(row.payload_json))
  return agentSessionSendBodyFingerprint(target.sessionId, card.body)
}

function heldResult(fingerprint: string, deadline: number, now: number) {
  return {
    status: 'held' as const,
    fingerprint,
    leaseDurationMs: QUEUED_MESSAGE_EDIT_LEASE_MS,
    remainingMs: Math.max(0, deadline - now)
  }
}

function acquireOrRenew(
  db: Database.Database,
  target: Target,
  ownerId: string,
  operation: Extract<JournalDomainEditLeaseOperation, { kind: 'acquire' | 'renew' }>,
  now: number
): Pick<JournalDomainEditLeaseOutcome, 'result' | 'changed'> {
  const existing = db
    .prepare(`SELECT lease.message_id, lease.expires_at, card.payload_json,
        card.message_id IS NOT NULL AND lease.expires_at>? AS live
      FROM journal_edit_leases AS lease LEFT JOIN journal_queue_cards AS card ON ${LIVE_CARD}
      WHERE lease.session_id=? AND lease.epoch=? AND lease.owner_id=? AND lease.caller_key=?
        AND lease.edit_id=?`)
    .get(now, target.sessionId, target.epoch, ownerId, operation.callerKey, operation.editId)
  const valid = existing !== undefined && Number(existing.live) === 1
  let changed = false
  if (existing && !valid) {
    changed = deletePair(db, target, ownerId, operation)
  }
  if (operation.kind === 'renew') {
    if (!valid || existing.message_id !== operation.messageId) {
      return { result: { status: 'expired' }, changed }
    }
    const deadline = Math.max(Number(existing.expires_at), now + QUEUED_MESSAGE_EDIT_LEASE_MS)
    if (deadline !== Number(existing.expires_at)) {
      db.prepare(`UPDATE journal_edit_leases SET expires_at=?
        WHERE session_id=? AND epoch=? AND owner_id=? AND caller_key=? AND edit_id=?`).run(
        deadline,
        target.sessionId,
        target.epoch,
        ownerId,
        operation.callerKey,
        operation.editId
      )
      changed = true
    }
    return { result: heldResult(bodyFingerprint(target, existing), deadline, now), changed }
  }
  if (valid) {
    const fingerprint =
      existing.message_id === operation.messageId ? bodyFingerprint(target, existing) : null
    return {
      result:
        fingerprint === operation.fingerprint
          ? heldResult(fingerprint, Number(existing.expires_at), now)
          : { status: 'changed' },
      changed
    }
  }
  const card = db
    .prepare(`SELECT revision, payload_json FROM journal_queue_cards
      WHERE session_id=? AND epoch=? AND message_id=? AND state IN ('waiting','returned')`)
    .get(target.sessionId, target.epoch, operation.messageId)
  if (!card) {
    return { result: { status: 'gone' }, changed }
  }
  const fingerprint = bodyFingerprint(target, card)
  if (fingerprint !== operation.fingerprint) {
    return { result: { status: 'changed' }, changed }
  }
  const deadline = now + QUEUED_MESSAGE_EDIT_LEASE_MS
  db.prepare(`INSERT INTO journal_edit_leases
    (session_id,epoch,owner_id,caller_key,edit_id,message_id,card_revision,expires_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    target.sessionId,
    target.epoch,
    ownerId,
    operation.callerKey,
    operation.editId,
    operation.messageId,
    card.revision,
    deadline
  )
  return { result: heldResult(fingerprint, deadline, now), changed: true }
}

/** The caller owns the writer transaction and publishes these facts only after COMMIT. */
export function applyJournalDomainEditLease(
  db: Database.Database,
  target: Target,
  ownerId: string,
  operation: JournalDomainEditLeaseOperation,
  now: number
): JournalDomainEditLeaseOutcome {
  requireWallClock(now)
  if (!db.isTransaction) {
    throw new Error('edit lease command requires the owning writer transaction')
  }
  let result: AgentSessionQueuedMessageEditHoldResult | null = null
  let changed = false
  switch (operation.kind) {
    case 'acquire':
    case 'renew':
      ;({ result, changed } = acquireOrRenew(db, target, ownerId, operation, now))
      break
    case 'release':
      changed =
        db
          .prepare(`DELETE FROM journal_edit_leases
        WHERE session_id=? AND epoch=? AND owner_id=? AND caller_key=? AND edit_id=? AND message_id=?`)
          .run(
            target.sessionId,
            target.epoch,
            ownerId,
            operation.callerKey,
            operation.editId,
            operation.messageId
          ).changes > 0
      result = { status: 'released' }
      break
    case 'retire-card':
      changed = retireJournalDomainEditHolds(db, target, [operation.messageId])
      break
    case 'release-owner':
      changed =
        db
          .prepare(`DELETE FROM journal_edit_leases
        WHERE session_id=? AND epoch=? AND owner_id=?`)
          .run(target.sessionId, target.epoch, ownerId).changes > 0
      break
    case 'expire':
      changed =
        db
          .prepare(`DELETE FROM journal_edit_leases AS lease
        WHERE session_id=? AND epoch=? AND (expires_at<=?
          OR NOT EXISTS(SELECT 1 FROM journal_queue_cards AS card WHERE ${LIVE_CARD}))`)
          .run(target.sessionId, target.epoch, now).changes > 0
      break
  }
  return { result, changed, nextDeadline: journalDomainEditLeaseDeadline(db, target, now) }
}
