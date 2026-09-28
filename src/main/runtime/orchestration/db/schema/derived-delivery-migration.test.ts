import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { dropDerivedDeliverySchema } from './derived-delivery-test-fixture'
import { resolveOrchestrationMigrationStartVersion } from '../../orchestration-schema-version-skew'
import { createRootDispatch } from '../root-dispatch-test-fixture'
import { SCHEMA_VERSION } from '../contract-constants'

describe('derived delivery migration', () => {
  const connections: OrchestrationDb[] = []
  const directories: string[] = []
  afterEach(() => {
    for (const db of connections.splice(0)) {
      db.close()
    }
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })
  function open(path: string) {
    const db = new OrchestrationDb(path)
    connections.push(db)
    return db
  }
  function databasePath() {
    const directory = mkdtempSync(join(tmpdir(), 'orca-derived-delivery-'))
    directories.push(directory)
    return join(directory, 'orchestration.db')
  }

  it('preserves batch identity and terminal facts while removing a persisted wedge', () => {
    const path = databasePath()
    const original = open(path)
    const run = original.createRun({
      objective: 'upgrade',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const params = { runId: run.id, consumerGeneration: run.consumer_generation }
    const old = original.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'old'
    })
    const batch = original.getDeliveryRaw(original.getOrCreateRunDelivery(params)!.delivery.id)!
    const next = original.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'next'
    })
    connections.pop()!.close()
    const raw = new Database(path)
    dropDerivedDeliverySchema(raw)
    raw.prepare('UPDATE messages SET read = 1 WHERE id = ?').run(old.id)
    raw.exec(`
      INSERT INTO deliveries (id, run_id, mailbox_handle, consumer_generation, message_ids, status, created_at, acknowledged_at)
      VALUES ('history_ack', '${run.id}', 'run:${run.id}', 1, '[]', 'acknowledged', '2026-01-01 00:00:00', '2026-01-02 00:00:00'),
             ('history_fence', '${run.id}', 'run:${run.id}', 1, '[]', 'fenced', '2026-01-03 00:00:00', NULL);
    `)
    raw.pragma('user_version = 40')
    raw.close()
    const db = open(path)
    expect(db.getDeliveryRaw(batch.id)).toEqual(batch)
    expect(db.hasOutstandingRunDelivery(run.id)).toBe(false)
    expect(db.getDeliveryRaw('history_ack')).toMatchObject({
      acknowledged_at: '2026-01-02 00:00:00',
      status: 'acknowledged'
    })
    expect(db.getDeliveryRaw('history_fence')).toMatchObject({
      acknowledged_at: null,
      status: 'fenced'
    })
    expect(() => db.acknowledgeRunDelivery({ ...params, deliveryId: 'history_fence' })).toThrow(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    expect(db.getOrCreateRunDelivery(params)?.messages.map((message) => message.id)).toEqual([
      next.id
    ])
    expect(db.getDeliveryRaw(batch.id)?.acknowledged_at).toBeNull()
    expect(resolveOrchestrationMigrationStartVersion(db.db, SCHEMA_VERSION, SCHEMA_VERSION)).toBe(
      SCHEMA_VERSION
    )
    const reopened = open(path)
    expect(reopened.getOrCreateRunDelivery(params)?.messages.map((message) => message.id)).toEqual([
      next.id
    ])
  })

  it('enforces one active batch using the same derived view and permits history', () => {
    const db = open(':memory:')
    const run = db.createRun({
      objective: 'constraint',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const message = db.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'one'
    })
    const params = { runId: run.id, consumerGeneration: run.consumer_generation }
    const first = db.getDeliveryRaw(db.getOrCreateRunDelivery(params)!.delivery.id)!
    const insert = db.db.prepare(`INSERT INTO deliveries
      (id, run_id, mailbox_handle, consumer_generation, message_ids, acknowledged_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
    const values = [run.id, `run:${run.id}`, run.consumer_generation, JSON.stringify([message.id])]
    expect(() => insert.run('duplicate', ...values, null, 'outstanding')).toThrow(
      'Mailbox already has an outstanding delivery'
    )
    expect(() =>
      insert.run('ack_history', ...values, '2026-01-01 00:00:00', 'acknowledged')
    ).not.toThrow()
    expect(() => insert.run('fenced_history', ...values, null, 'fenced')).not.toThrow()
    db.markAsRead([message.id])
    expect(() => insert.run('consumed_history', ...values, null, 'outstanding')).not.toThrow()
    expect(db.getDeliveryRaw(first.id)).toEqual(first)
    expect(db.hasOutstandingRunDelivery(run.id)).toBe(false)
  })

  it('shares a single batch across connections and rejects replaced consumers after it is consumed', () => {
    const path = databasePath()
    const first = open(path)
    const run = first.createRun({
      objective: 'connections',
      coordinatorHandle: 'coord',
      coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
    })
    const params = { runId: run.id, consumerGeneration: run.consumer_generation }
    const message = first.insertMessage({
      runId: run.id,
      from: 'worker',
      to: `run:${run.id}`,
      subject: 'one'
    })
    const second = open(path)
    const batch = first.getOrCreateRunDelivery(params)!
    expect(second.getOrCreateRunDelivery(params)?.delivery.id).toBe(batch.delivery.id)
    second.markAsRead([message.id])
    const replacement = second.bindRun({
      runId: run.id,
      coordinatorHandle: 'replacement',
      coordinatorPaneKey: 'other:22222222-2222-4222-9222-222222222222'
    })!
    expect(first.getDeliveryRaw(batch.delivery.id)).toMatchObject({
      status: 'fenced',
      acknowledged_at: null
    })
    first.insertMessage({ runId: run.id, from: 'worker', to: `run:${run.id}`, subject: 'next' })
    expect(() => first.getOrCreateRunDelivery(params)).toThrow(
      expect.objectContaining({ code: 'consumer_fenced' })
    )
    expect(() =>
      first.acknowledgeRunDelivery({ ...params, deliveryId: batch.delivery.id })
    ).toThrow(expect.objectContaining({ code: 'consumer_fenced' }))
    expect(
      second.getOrCreateRunDelivery({
        ...params,
        consumerGeneration: replacement.consumer_generation
      })?.messages[0].subject
    ).toBe('next')
  })

  it.each(['dispatch', 'attachment'] as const)(
    'fences a stale %s consumer across connections even after its batch is read',
    (consumerSource) => {
      const path = databasePath()
      const db = open(path)
      const run = db.createRun({
        objective: 'worker connections',
        coordinatorHandle: 'coord',
        coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
      })
      const dispatchId =
        consumerSource === 'dispatch'
          ? createRootDispatch(db, db.createTask({ spec: 'work', runId: run.id }).id, 'worker').id
          : 'ctx_remote'
      if (consumerSource === 'attachment') {
        db.createRemoteDispatchAttachment({
          runId: run.id,
          dispatchId,
          taskId: 'task_remote',
          homePeerFingerprint: 'peer',
          runtimeEpoch: 'epoch',
          protocolVersion: 1,
          mutationReceipt: {
            callerFingerprint: 'peer',
            requestId: 'attach',
            method: 'orchestration.federationAttachStart',
            payloadHash: 'hash'
          }
        })
      }
      const mailboxHandle = `dispatch:${dispatchId}`
      const message = db.insertMessage({
        runId: run.id,
        from: 'coord',
        to: mailboxHandle,
        subject: 'old'
      })
      const params = { runId: run.id, mailboxHandle, consumerGeneration: 0, consumerSource }
      const batch = db.getOrCreateMailboxDelivery(params)!
      const peer = open(path)
      peer.markAsRead([message.id])
      const authority = {
        dispatchId,
        paneKey: 'other:22222222-2222-4222-9222-222222222222',
        processIncarnation: 'worker:2'
      }
      if (consumerSource === 'dispatch') {
        peer.mintDispatchCapability(authority)
      } else {
        peer.prepareRemoteAttachmentAuthority({
          ...authority,
          worktreeId: 'folder',
          terminalHandle: 'replacement',
          setupState: 'not_applicable',
          effects: []
        })
      }
      expect(db.getDeliveryRaw(batch.delivery.id)).toMatchObject({
        status: 'fenced',
        acknowledged_at: null
      })
      peer.insertMessage({ runId: run.id, from: 'coord', to: mailboxHandle, subject: 'next' })
      expect(() => db.getOrCreateMailboxDelivery(params)).toThrow(
        expect.objectContaining({ code: 'consumer_fenced' })
      )
      expect(() =>
        db.acknowledgeMailboxDelivery({ ...params, deliveryId: batch.delivery.id })
      ).toThrow(expect.objectContaining({ code: 'consumer_fenced' }))
      expect(
        peer.getOrCreateMailboxDelivery({ ...params, consumerGeneration: 1 })?.messages[0].subject
      ).toBe('next')
    }
  )

  it('keeps the pre-v41 column and index shape a downgraded binary reads', () => {
    const db = open(':memory:')
    expect(
      (db.db.pragma('table_info(deliveries)') as { name: string }[]).map((c) => c.name)
    ).toContain('status')
    const index = db.db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_deliveries_one_outstanding'")
      .get() as { sql: string }
    expect(index.sql).not.toContain('UNIQUE')
    expect(index.sql).toContain("status = 'outstanding' AND mailbox_handle != ''")
    // Why: a v40 binary probes exactly these objects before trusting the stamp; nothing it needs is gone.
    expect(resolveOrchestrationMigrationStartVersion(db.db, SCHEMA_VERSION, 40)).toBe(
      SCHEMA_VERSION
    )
  })

  it('recreates a missing derived view on reopen without changing batch records', () => {
    const path = databasePath()
    const db = open(path)
    db.db.exec('DROP VIEW outstanding_deliveries')
    const reopened = open(path)
    expect(reopened.hasOutstandingMailboxDelivery('run:missing')).toBe(false)
    expect(
      resolveOrchestrationMigrationStartVersion(reopened.db, SCHEMA_VERSION, SCHEMA_VERSION)
    ).toBe(SCHEMA_VERSION)
  })
})
