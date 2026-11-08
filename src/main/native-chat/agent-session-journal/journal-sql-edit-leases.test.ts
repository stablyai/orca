import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import {
  applyJournalDomainEditLease,
  journalDomainEditLeaseDeadline,
  journalDomainHeldMessageIds,
  journalDomainMessageEditHeld,
  type JournalDomainEditLeaseOperation
} from './journal-domain-edit-leases'

const target = { sessionId: 'chat', epoch: 'epoch' }
const fingerprint = '44edcc201d3be8e4833524b584e6d07f220d9667be17c917760bc3fb4fc31a41'
const editedFingerprint = '6cd1b1fca48febf02017694c66802db648b4c6d96330cc985b7287c5e5386425'
const desktop = { callerKey: 'desktop', editId: 'edit-1' }
const acquire = { kind: 'acquire', ...desktop, messageId: 'card', fingerprint } as const
const databases: Database.Database[] = []

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  // Each seed is a content or state write on the one current row, as the queue writers make.
  const seed = (fields: Partial<QueuedMessageRow> = {}) => {
    const { messageId, state, position, ...card }: QueuedMessageRow = {
      messageId: 'card',
      position: 1,
      body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
      fingerprint: 'stale-serialized-fingerprint',
      state: 'waiting',
      holdReason: null,
      returnedReason: null,
      returnedRejection: null,
      consumedAs: null,
      queuedAt: null,
      ...fields
    }
    db.prepare(`INSERT INTO journal_queue_cards
      (session_id,epoch,message_id,revision,state,position,payload_json) VALUES(?,?,?,1,?,?,?)
      ON CONFLICT(session_id,epoch,message_id) DO UPDATE SET revision=revision+1,
        state=excluded.state, payload_json=excluded.payload_json`).run(
      target.sessionId,
      target.epoch,
      messageId,
      state,
      position,
      JSON.stringify(card)
    )
  }
  const write = (
    operation: JournalDomainEditLeaseOperation,
    now = 1_800_000_000_000,
    ownerId = 'handle-a'
  ) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = applyJournalDomainEditLease(db, target, ownerId, operation, now)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
  seed()
  return { db, seed, write }
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

it('keeps several caller/edit pairs and repeats without extending or replacing a pair', () => {
  const { db, seed, write } = fixture()
  seed({ messageId: 'second' })
  expect(write(acquire)).toEqual({
    result: { status: 'held', fingerprint, leaseDurationMs: 120_000, remainingMs: 120_000 },
    changed: true,
    nextDeadline: 1_800_000_120_000
  })
  write({ ...acquire, editId: 'edit-2' }, 1_800_000_000_500)
  write({ ...acquire, callerKey: 'phone' }, 1_800_000_000_500)
  expect(write(acquire, 1_800_000_001_000)).toEqual({
    result: { status: 'held', fingerprint, leaseDurationMs: 120_000, remainingMs: 119_000 },
    changed: false,
    nextDeadline: 1_800_000_120_000
  })
  expect(write({ ...acquire, messageId: 'second' }).result).toEqual({ status: 'changed' })
  expect(write({ ...acquire, fingerprint: 'different' }).result).toEqual({ status: 'changed' })
  expect(write({ kind: 'release', ...desktop, messageId: 'second' }).changed).toBe(false)
  expect(write({ kind: 'release', ...desktop, messageId: 'card' })).toEqual({
    result: { status: 'released' },
    changed: true,
    nextDeadline: 1_800_000_120_500
  })
  expect(journalDomainHeldMessageIds(db, target, 1_800_000_001_000)).toEqual(['card'])
  write({ kind: 'release', ...desktop, editId: 'edit-2', messageId: 'card' })
  expect(journalDomainMessageEditHeld(db, target, 'card', 1_800_000_001_000)).toBe(true)
  write({ kind: 'release', ...desktop, callerKey: 'phone', messageId: 'card' })
  expect(journalDomainHeldMessageIds(db, target, 1_800_000_001_000)).toEqual([])
})

it('renews only the exact pair and treats expired leases as unheld on read-only queries', () => {
  const { db, write } = fixture()
  write(acquire)
  expect(write({ kind: 'renew', ...desktop, messageId: 'second' }).result).toEqual({
    status: 'expired'
  })
  expect(write({ kind: 'renew', ...desktop, messageId: 'card' }, 1_800_000_001_000)).toEqual({
    result: { status: 'held', fingerprint, leaseDurationMs: 120_000, remainingMs: 120_000 },
    changed: true,
    nextDeadline: 1_800_000_121_000
  })
  db.pragma('query_only=1')
  expect(journalDomainMessageEditHeld(db, target, 'card', 1_800_000_120_999)).toBe(true)
  expect(journalDomainEditLeaseDeadline(db, target, 1_800_000_120_999)).toBe(1_800_000_121_000)
  expect(journalDomainMessageEditHeld(db, target, 'card', 1_800_000_121_000)).toBe(false)
  expect(journalDomainHeldMessageIds(db, target, 1_800_000_121_000)).toEqual([])
  expect(journalDomainEditLeaseDeadline(db, target, 1_800_000_121_000)).toBeNull()
  db.pragma('query_only=0')
  expect(write({ kind: 'expire' }, 1_800_000_121_000)).toEqual({
    result: null,
    changed: true,
    nextDeadline: null
  })
  expect(write({ kind: 'renew', ...desktop, messageId: 'card' }, 1_800_000_121_000).result).toEqual(
    { status: 'expired' }
  )
  expect(write(acquire, 1_800_000_121_000).result).toMatchObject({
    status: 'held',
    remainingMs: 120_000
  })
  expect(write({ kind: 'renew', ...desktop, messageId: 'card' }, 1_800_000_241_000)).toEqual({
    result: { status: 'expired' },
    changed: true,
    nextDeadline: null
  })
})

it('derives the current head fingerprint from its body and invalidates body-only edits', () => {
  const { db, seed, write } = fixture()
  write(acquire)
  seed({ body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'edited' }] } })
  db.pragma('query_only=1')
  expect(journalDomainMessageEditHeld(db, target, 'card', 1_800_000_000_000)).toBe(false)
  expect(journalDomainEditLeaseDeadline(db, target, 1_800_000_000_000)).toBeNull()
  db.pragma('query_only=0')
  expect(write({ kind: 'renew', ...desktop, messageId: 'card' })).toEqual({
    result: { status: 'expired' },
    changed: true,
    nextDeadline: null
  })
  expect(write(acquire).result).toEqual({ status: 'changed' })
  expect(write({ ...acquire, fingerprint: editedFingerprint }).result).toEqual({
    status: 'held',
    fingerprint: editedFingerprint,
    leaseDurationMs: 120_000,
    remainingMs: 120_000
  })
})

it('invalidates state and consumed-attempt changes even when the body is unchanged', () => {
  const { db, seed, write } = fixture()
  write(acquire)
  seed({ state: 'returned' })
  expect(journalDomainHeldMessageIds(db, target, 1_800_000_000_000)).toEqual([])
  expect(write({ kind: 'expire' }).changed).toBe(true)
  expect(write(acquire).result).toMatchObject({ status: 'held' })
  seed({ state: 'returned', consumedAs: 'attempt-1' })
  expect(journalDomainMessageEditHeld(db, target, 'card', 1_800_000_000_000)).toBe(false)
  expect(write({ kind: 'renew', ...desktop, messageId: 'card' }).result).toEqual({
    status: 'expired'
  })
  expect(write(acquire).result).toMatchObject({ status: 'held' })
  seed({ state: 'withdrawn' })
  expect(write(acquire)).toEqual({ result: { status: 'gone' }, changed: true, nextDeadline: null })
  expect(write({ ...acquire, messageId: 'missing' }).result).toEqual({ status: 'gone' })
})

it('releases only the named owner and retires only the addressed card', () => {
  const { db, seed, write } = fixture()
  seed({ messageId: 'second' })
  write(acquire)
  write(acquire, 1_800_000_000_000, 'handle-b')
  write({ ...acquire, messageId: 'second', editId: 'edit-2' }, 1_800_000_000_000, 'handle-b')
  expect(write({ kind: 'release-owner' }, 1_800_000_000_000, 'unknown-owner').changed).toBe(false)
  expect(write({ kind: 'release-owner' }).changed).toBe(true)
  expect(journalDomainMessageEditHeld(db, target, 'card', 1_800_000_000_000)).toBe(true)
  expect(write({ kind: 'renew', ...desktop, messageId: 'card' }).result).toEqual({
    status: 'expired'
  })
  expect(write({ kind: 'retire-card', messageId: 'card' }).changed).toBe(true)
  expect(journalDomainHeldMessageIds(db, target, 1_800_000_000_000)).toEqual(['second'])
  write({ kind: 'release-owner' }, 1_800_000_000_000, 'handle-b')
  expect(journalDomainHeldMessageIds(db, target, 1_800_000_000_000)).toEqual([])
})

it('requires the caller transaction and leaves commit and savepoint rollback to that caller', () => {
  const { db } = fixture()
  expect(() =>
    applyJournalDomainEditLease(db, target, 'handle-a', acquire, 1_800_000_000_000)
  ).toThrow('requires the owning writer transaction')
  db.exec('BEGIN IMMEDIATE; SAVEPOINT lease_step')
  applyJournalDomainEditLease(db, target, 'handle-a', acquire, 1_800_000_000_000)
  expect(journalDomainMessageEditHeld(db, target, 'card', 1_800_000_000_000)).toBe(true)
  db.exec('ROLLBACK TO lease_step; RELEASE lease_step; COMMIT')
  expect(journalDomainMessageEditHeld(db, target, 'card', 1_800_000_000_000)).toBe(false)
})
