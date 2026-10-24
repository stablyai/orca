import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import SyncDatabase from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { drainLegacyMailHandoff } from './legacy-mail-handoff'
import { readMailHandoff, UNKNOWN_MAIL_HANDOFF } from './mail-handoff'
import { selectStructuredMailHandoff, type StructuredMailEvidence } from './mailbox-settlement'

it.each(['accepted', 'rejected', 'missing-membership'] as const)(
  'upgrades a legacy %s notice without suppressing unrelated pre-upgrade mail',
  async (dispatchState) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-mail-handoff-upgrade-'))
    const path = join(directory, 'orchestration.db')
    let db = new OrchestrationDb(path)
    try {
      const member = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'old' })
      const fresh = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'new' })
      db.putStructuredPointerOperation({
        mailbox_handle: 'consumer',
        session_id: 'session',
        operation_id: 'legacy-operation',
        batch_fingerprint: 'legacy-fingerprint',
        minted_at_ms: 1
      })
      db.db.pragma('user_version = 43')
      db.close()
      db = new OrchestrationDb(path)
      const evidence: StructuredMailEvidence = {
        epoch: 'epoch',
        frontier: 'new-host',
        stopInForce: false,
        submission: {
          clientMessageId: 'legacy-operation',
          fence: 1,
          payloadFingerprint: 'payload',
          dispatchState: dispatchState === 'rejected' ? 'rejected' : 'accepted',
          providerItemId: null,
          reason: 'provider_write_failed',
          submittedAt: 1,
          resolvedAt: 2
        },
        owner: null,
        personStopped: false,
        diedTurnId: null,
        legacyNotice: {
          message: 'mail-notice',
          mailbox: 'consumer',
          dispatchId: null,
          messages: [{ messageId: member.id, runId: member.run_id, from: member.from_handle }]
        }
      }
      if (dispatchState === 'missing-membership') {
        drainLegacyMailHandoff(db, db.getStructuredPointerOperation('consumer')!, {
          ...evidence,
          legacyNotice: null
        })
        expect(db.getStructuredPointerOperation('consumer')?.operation_id).toBe('legacy-operation')
        expect(
          [member, fresh].map((row) => readMailHandoff(db.getMessageById(row.id)?.handoff))
        ).toEqual([
          { version: 1, kind: 'unknown' },
          { version: 1, kind: 'unknown' }
        ])
        const later = db.insertMessage({ from: 'sender', to: 'consumer', subject: 'after upgrade' })
        expect(
          db
            .getAutomaticMailCandidates('consumer', {
              afterSequence: 0,
              excludeTypes: [],
              limit: 50
            })
            .map((row) => row.id)
        ).toEqual([later.id])
        expect(db.getUnreadMessages('consumer').map((row) => row.id)).toEqual([
          member.id,
          fresh.id,
          later.id
        ])
        return
      }
      drainLegacyMailHandoff(db, db.getStructuredPointerOperation('consumer')!, evidence)
      expect(db.getStructuredPointerOperation('consumer')).toBeUndefined()
      expect(db.getMessageById(fresh.id)?.handoff).toBeNull()
      expect(readMailHandoff(db.getMessageById(member.id)?.handoff)).toMatchObject(
        dispatchState === 'accepted'
          ? { kind: 'unknown' }
          : { kind: 'structured', operationId: 'legacy-operation', nonAdmission: 'refused' }
      )
      const select = () =>
        selectStructuredMailHandoff({
          db,
          mailbox: 'consumer',
          sessionId: 'session',
          epoch: 'epoch',
          frontier: 'new-host',
          waiters: undefined,
          reservedTypes: undefined,
          readEvidence: async () => evidence
        })
      const batch = await select()
      expect(batch?.messages.map((row) => row.id)).toEqual(
        dispatchState === 'accepted' ? [fresh.id] : [member.id, fresh.id]
      )
      db.markAsRead([fresh.id])
      const remaining = await select()
      if (dispatchState === 'accepted') {
        expect(remaining).toBeNull()
      } else {
        expect(remaining?.reference.authorizationId).toBe('legacy-operation')
        expect(remaining?.reference.operationId).not.toBe('legacy-operation')
        expect(db.getMessageById(member.id)?.recovery_used).toBe(0)
      }
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it('upgrades N/10N fetched history with one membership traversal and unchanged uncertainty', () => {
  const costs: number[] = []
  const plans: string[][] = []
  for (const count of [100, 1000]) {
    const directory = mkdtempSync(join(tmpdir(), 'orca-mail-membership-upgrade-'))
    const path = join(directory, 'orchestration.db')
    let db: OrchestrationDb | undefined = new OrchestrationDb(path)
    let migrationSql = ''
    let membershipVisits = 0
    const prepare = SyncDatabase.prototype.prepare
    const capture = vi.spyOn(SyncDatabase.prototype, 'prepare').mockImplementation(function (
      this: SyncDatabase,
      sql
    ) {
      if (sql.includes('json_each(d.message_ids)')) {
        migrationSql = sql
        const native = z
          .instanceof(DatabaseSync)
          .parse(Object.getOwnPropertyDescriptor(this, 'db')?.value)
        native.function('observe_membership', { deterministic: true }, (value) => {
          membershipVisits++
          return value
        })
        const observed = sql.replace('m.value', 'observe_membership(m.value)')
        const plan = (query: string) =>
          native
            .prepare(`EXPLAIN QUERY PLAN ${query}`)
            .all(UNKNOWN_MAIL_HANDOFF)
            .map((row) => row.detail)
        expect(plan(observed)).toEqual(plan(sql))
        return prepare.call(this, observed)
      }
      return prepare.call(this, sql)
    })
    try {
      const run = db.createRun({
        objective: 'retained check history',
        coordinatorHandle: 'coord',
        coordinatorPaneKey: 'coord:pane'
      })
      const mailbox = `run:${run.id}`
      const members = Array.from({ length: count }, () =>
        db!.insertMessage({ runId: run.id, from: 'worker', to: mailbox, subject: 'checked' })
      )
      const consumer = {
        runId: run.id,
        mailboxHandle: mailbox,
        consumerGeneration: run.consumer_generation
      }
      for (let offset = 0; offset < count; offset += 50) {
        const fetched = db.getOrCreateMailboxDelivery(consumer)!
        expect(fetched.messages).toHaveLength(50)
        db.acknowledgeMailboxDelivery({ ...consumer, deliveryId: fetched.delivery.id })
      }
      db.db
        .prepare(
          "UPDATE deliveries SET status = 'fenced' WHERE rowid = (SELECT min(rowid) FROM deliveries)"
        )
        .run()
      const outstanding = db.insertMessage({
        runId: run.id,
        from: 'worker',
        to: mailbox,
        subject: 'fetched unread'
      })
      expect(db.getOrCreateMailboxDelivery(consumer)?.messages.map((row) => row.id)).toEqual([
        outstanding.id
      ])
      const controls = ['delivered', 'ambiguous', 'legacy', 'fresh', 'reserved'].map((subject) =>
        db!.insertMessage({ from: 'worker', to: subject, subject })
      )
      db.db
        .prepare("UPDATE messages SET delivered_at = datetime('now') WHERE id = ?")
        .run(controls[0]!.id)
      db.db
        .prepare('UPDATE messages SET pointer_enter_pending = 2 WHERE id = ?')
        .run(controls[1]!.id)
      db.db
        .prepare('UPDATE messages SET pointer_enter_pending = 1 WHERE id = ?')
        .run(controls[4]!.id)
      db.putStructuredPointerOperation({
        mailbox_handle: 'legacy',
        session_id: 'session',
        operation_id: 'old-operation',
        batch_fingerprint: 'old-fingerprint',
        minted_at_ms: 1
      })
      expect(members.every((row) => db!.getMessageById(row.id)?.delivered_at === null)).toBe(true)
      db.db.exec('ALTER TABLE messages DROP COLUMN handoff')
      db.db.exec('ALTER TABLE messages DROP COLUMN recovery_used')
      db.db.pragma('user_version = 43')
      db.close()
      db = undefined
      db = new OrchestrationDb(path)
      capture.mockRestore()
      expect(migrationSql).not.toBe('')
      plans.push(
        db.db
          .prepare(`EXPLAIN QUERY PLAN ${migrationSql}`)
          .all(UNKNOWN_MAIL_HANDOFF)
          .map((row) => String(row.detail))
      )
      expect(
        members.every(
          (row) => readMailHandoff(db!.getMessageById(row.id)?.handoff)?.kind === 'unknown'
        )
      ).toBe(true)
      expect(
        controls.map((row) => readMailHandoff(db!.getMessageById(row.id)?.handoff)?.kind ?? null)
      ).toEqual(['unknown', 'unknown', 'unknown', null, null])
      expect(db.db.pragma('user_version', { simple: true })).toBe(44)
      expect(db.getMessageById(outstanding.id)).toMatchObject({
        read: 0,
        delivered_at: null,
        handoff: UNKNOWN_MAIL_HANDOFF
      })
      expect(JSON.parse(db.getMessageById(controls[2]!.id)!.handoff!)).toEqual({
        version: 1,
        kind: 'legacy',
        operationId: 'old-operation'
      })
      db.close()
      db = undefined
      // Actual Node SQLite visits every fetched member once, including fenced/unread deliveries.
      expect(membershipVisits).toBe(count + 1)
      costs.push(membershipVisits)
    } finally {
      capture.mockRestore()
      db?.close()
      rmSync(directory, { recursive: true, force: true })
    }
  }
  console.info('native fetched-history upgrade membership visits N/10N', costs)
  for (const plan of plans) {
    expect.soft(plan.some((detail) => detail.includes('CORRELATED'))).toBe(false)
  }
  expect(costs[0]).toBeGreaterThan(0)
  expect(costs[1]).toBeLessThanOrEqual(costs[0]! * 10)
})
