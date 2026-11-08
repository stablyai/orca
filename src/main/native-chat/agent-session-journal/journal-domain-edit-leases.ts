import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { AgentSessionQueuedMessageEditHoldResult } from '../../../shared/agent-session/requests/agent-session-queued-message-wire'
import { agentSessionSendBodyFingerprint } from '../../../shared/agent-session/requests/structured-agent-session-send-mutation'
import {
  leaseMatchesRow,
  QUEUED_MESSAGE_EDIT_LEASE_MS,
  type EditLeaseKey
} from './queued-messages/queued-message-edit-leases'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

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

const SELECT_LEASE_CARDS = `SELECT
  lease.owner_id, lease.caller_key, lease.edit_id, lease.message_id,
  lease.fingerprint, lease.state, lease.consumed_as, lease.expires_at,
  card.state AS current_state, card.payload_json
FROM journal_edit_leases AS lease
LEFT JOIN journal_card_versions AS card
  ON card.session_id=lease.session_id AND card.epoch=lease.epoch
  AND card.message_id=lease.message_id AND card.current=1
WHERE lease.session_id=? AND lease.epoch=?`

function requireWallClock(now: number): void {
  if (!Number.isFinite(now)) {
    throw new Error('edit lease requires finite wall-clock milliseconds')
  }
}

function currentCard(target: Target, messageId: string, row: SqliteRow): QueuedMessageRow | null {
  if (
    row.payload_json === null ||
    (row.current_state !== 'waiting' && row.current_state !== 'returned')
  ) {
    return null
  }
  const card: QueuedMessageRow = JSON.parse(String(row.payload_json))
  return {
    ...card,
    messageId,
    state: row.current_state,
    fingerprint: agentSessionSendBodyFingerprint(target.sessionId, card.body)
  }
}

function leaseIsCurrent(target: Target, row: SqliteRow, now: number): boolean {
  if (Number(row.expires_at) <= now) {
    return false
  }
  const messageId = String(row.message_id)
  const card = currentCard(target, messageId, row)
  return (
    card !== null &&
    leaseMatchesRow(
      {
        messageId,
        fingerprint: String(row.fingerprint),
        state: row.state === 'waiting' ? 'waiting' : 'returned',
        consumedAs: row.consumed_as === null ? null : String(row.consumed_as)
      },
      card
    )
  )
}

/** One joined statement keeps lease validity and the current card in the caller's snapshot. */
export function journalDomainMessageEditHeld(
  db: Database.Database,
  target: Target,
  messageId: string,
  now: number
): boolean {
  requireWallClock(now)
  for (const row of db
    .prepare(`${SELECT_LEASE_CARDS} AND lease.message_id=? AND lease.expires_at>?`)
    .iterate(target.sessionId, target.epoch, messageId, now)) {
    if (leaseIsCurrent(target, row, now)) {
      return true
    }
  }
  return false
}

export function journalDomainHeldMessageIds(
  db: Database.Database,
  target: Target,
  now: number
): string[] {
  requireWallClock(now)
  const held = new Set<string>()
  for (const row of db
    .prepare(`${SELECT_LEASE_CARDS} AND lease.expires_at>? ORDER BY lease.expires_at`)
    .iterate(target.sessionId, target.epoch, now)) {
    if (leaseIsCurrent(target, row, now)) {
      held.add(String(row.message_id))
    }
  }
  return [...held]
}

export function journalDomainEditLeaseDeadline(
  db: Database.Database,
  target: Target,
  now: number
): number | null {
  requireWallClock(now)
  for (const row of db
    .prepare(`${SELECT_LEASE_CARDS} AND lease.expires_at>? ORDER BY lease.expires_at`)
    .iterate(target.sessionId, target.epoch, now)) {
    if (leaseIsCurrent(target, row, now)) {
      return Number(row.expires_at)
    }
  }
  return null
}

function deletePair(db: Database.Database, target: Target, row: SqliteRow): boolean {
  return (
    db
      .prepare(`DELETE FROM journal_edit_leases
        WHERE session_id=? AND epoch=? AND owner_id=? AND caller_key=? AND edit_id=?`)
      .run(target.sessionId, target.epoch, row.owner_id, row.caller_key, row.edit_id).changes > 0
  )
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
    .prepare(
      `${SELECT_LEASE_CARDS} AND lease.owner_id=? AND lease.caller_key=? AND lease.edit_id=?`
    )
    .get(target.sessionId, target.epoch, ownerId, operation.callerKey, operation.editId)
  const valid = existing !== undefined && leaseIsCurrent(target, existing, now)
  let changed = false
  if (existing && !valid) {
    changed = deletePair(db, target, existing)
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
    return { result: heldResult(String(existing.fingerprint), deadline, now), changed }
  }
  if (valid) {
    return {
      result:
        existing.message_id === operation.messageId &&
        existing.fingerprint === operation.fingerprint
          ? heldResult(String(existing.fingerprint), Number(existing.expires_at), now)
          : { status: 'changed' },
      changed
    }
  }
  const row = db
    .prepare(`SELECT state AS current_state, payload_json FROM journal_card_versions
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
    .get(target.sessionId, target.epoch, operation.messageId)
  const card = row ? currentCard(target, operation.messageId, row) : null
  if (!card) {
    return { result: { status: 'gone' }, changed }
  }
  if (card.fingerprint !== operation.fingerprint) {
    return { result: { status: 'changed' }, changed }
  }
  const deadline = now + QUEUED_MESSAGE_EDIT_LEASE_MS
  db.prepare(`INSERT INTO journal_edit_leases
    (session_id,epoch,owner_id,caller_key,edit_id,message_id,fingerprint,state,consumed_as,expires_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    target.sessionId,
    target.epoch,
    ownerId,
    operation.callerKey,
    operation.editId,
    card.messageId,
    card.fingerprint,
    card.state,
    card.consumedAs,
    deadline
  )
  return { result: heldResult(card.fingerprint, deadline, now), changed: true }
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
      changed =
        db
          .prepare(`DELETE FROM journal_edit_leases
        WHERE session_id=? AND epoch=? AND message_id=?`)
          .run(target.sessionId, target.epoch, operation.messageId).changes > 0
      break
    case 'release-owner':
      changed =
        db
          .prepare(`DELETE FROM journal_edit_leases
        WHERE session_id=? AND epoch=? AND owner_id=?`)
          .run(target.sessionId, target.epoch, ownerId).changes > 0
      break
    case 'expire':
      for (const row of db.prepare(SELECT_LEASE_CARDS).all(target.sessionId, target.epoch)) {
        if (!leaseIsCurrent(target, row, now)) {
          changed = deletePair(db, target, row) || changed
        }
      }
      break
  }
  return { result, changed, nextDeadline: journalDomainEditLeaseDeadline(db, target, now) }
}
