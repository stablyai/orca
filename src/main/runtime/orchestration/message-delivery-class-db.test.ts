import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

// The shipped schema one version back: same messages table without delivery_class.
const PRE_DELIVERY_CLASS_MESSAGES_SCHEMA = `
  CREATE TABLE messages_pre26 (
    id            TEXT NOT NULL,
    run_id        TEXT NOT NULL,
    delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
      CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')),
    from_handle   TEXT NOT NULL,
    to_handle     TEXT NOT NULL,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL DEFAULT '',
    type          TEXT NOT NULL DEFAULT 'status'
      CHECK(type IN (
        'status', 'dispatch', 'worker_done', 'merge_ready',
        'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
      )),
    priority      TEXT NOT NULL DEFAULT 'normal'
      CHECK(priority IN ('normal', 'high', 'urgent')),
    thread_id     TEXT,
    payload       TEXT,
    read          INTEGER NOT NULL DEFAULT 0,
    sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at  TEXT,
    sender_pane_key TEXT
  );
  INSERT INTO messages_pre26 (
    id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, priority,
    thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key
  )
  SELECT
    id, run_id, delivery_contract, from_handle, to_handle, subject, body, type, priority,
    thread_id, payload, read, sequence, created_at, delivered_at, sender_pane_key
  FROM messages;
  DROP TABLE messages;
  ALTER TABLE messages_pre26 RENAME TO messages;
  CREATE UNIQUE INDEX idx_messages_id ON messages(id);
  CREATE INDEX idx_inbox ON messages(to_handle, read);
  CREATE INDEX idx_thread ON messages(thread_id);
  CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence);
  CREATE INDEX idx_messages_delivery_contract
    ON messages(run_id, delivery_contract, to_handle, read, sequence);
`

describe('message delivery class storage', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  function createRun(target: OrchestrationDb): string {
    return target.createRun({
      objective: 'delivery class',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }).id
  }

  it('defaults to turn, which is the boundary a polled mailbox already delivers at', () => {
    db = new OrchestrationDb(':memory:')
    const runId = createRun(db)

    const message = db.insertMessage({ from: 'term_a', to: `run:${runId}`, subject: 'hi', runId })

    expect(message.delivery_class).toBe('turn')
  })

  it('stores the class the sender asked for, beside the message type', () => {
    db = new OrchestrationDb(':memory:')
    const runId = createRun(db)

    const message = db.insertMessage({
      from: 'term_a',
      to: `run:${runId}`,
      subject: 'stop what you are doing',
      type: 'escalation',
      deliveryClass: 'interrupt',
      runId
    })

    expect(message.type).toBe('escalation')
    expect(message.delivery_class).toBe('interrupt')
    expect(db.getMessageById(message.id)?.delivery_class).toBe('interrupt')
    expect(db.getRunMailboxHistory(runId)[0]?.delivery_class).toBe('interrupt')
  })

  it('refuses a class outside the three the schema knows', () => {
    db = new OrchestrationDb(':memory:')
    const runId = createRun(db)
    const target = db

    expect(() =>
      target.insertMessage({
        from: 'term_a',
        to: `run:${runId}`,
        subject: 'nope',
        deliveryClass: 'immediate' as never,
        runId
      })
    ).toThrow()
  })

  it('adds the column to an existing database and reads stored mail as turn', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-delivery-class-'))
    const dbPath = join(tempDir, 'orchestration.db')

    const before = new OrchestrationDb(dbPath)
    const runId = createRun(before)
    const stored = before.insertMessage({
      from: 'term_a',
      to: `run:${runId}`,
      subject: 'sent before the upgrade',
      runId
    })
    before.close()

    const raw = new Database(dbPath)
    raw.exec(PRE_DELIVERY_CLASS_MESSAGES_SCHEMA)
    raw.pragma('user_version = 25')
    raw.close()

    db = new OrchestrationDb(dbPath)

    expect(db.getMessageById(stored.id)?.delivery_class).toBe('turn')
    expect(
      db.insertMessage({
        from: 'term_a',
        to: `run:${runId}`,
        subject: 'sent after the upgrade',
        deliveryClass: 'tool',
        runId
      }).delivery_class
    ).toBe('tool')
  })
})
