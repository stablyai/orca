import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../../sqlite/sync-database'
import { OrchestrationDb } from '../orchestration-db'
import { dropDerivedDeliverySchema } from './derived-delivery-test-fixture'
import { textColumnValues } from '../../../../sqlite/sqlite-row-columns'

// The messages table as a long-lived v46 database has it: the v9 rebuild, then columns added by ALTER.
const V46_MESSAGES_SQL = `CREATE TABLE "messages" (
            id              TEXT NOT NULL,
            run_id          TEXT NOT NULL DEFAULT 'run_legacy_local',
            from_handle     TEXT NOT NULL,
            to_handle       TEXT NOT NULL,
            subject         TEXT NOT NULL,
            body            TEXT NOT NULL DEFAULT '',
            type            TEXT NOT NULL DEFAULT 'status'
              CHECK(type IN (
                'status', 'dispatch', 'worker_done', 'merge_ready',
                'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
              )),
            priority        TEXT NOT NULL DEFAULT 'normal'
              CHECK(priority IN ('normal', 'high', 'urgent')),
            thread_id       TEXT,
            payload         TEXT,
            read            INTEGER NOT NULL DEFAULT 0,
            sequence        INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            delivered_at    TEXT,
            sender_pane_key TEXT
          , delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
         CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')), pointer_enter_pending INTEGER NOT NULL DEFAULT 0, pointer_pty_id TEXT, pointer_process_incarnation TEXT, answer_sender_snapshot TEXT)`

const SAMPLE = {
  id: 'msg_sample',
  run_id: 'run_sample',
  from_handle: 'term_a',
  to_handle: 'dispatch:ctx_b',
  subject: 'Sample',
  body: 'Body',
  type: 'question',
  priority: 'high',
  thread_id: 'msg_thread',
  payload: '{"k":1}',
  read: 1,
  sequence: 7,
  created_at: '2026-01-02 03:04:05',
  delivered_at: '2026-01-02 03:04:06',
  sender_pane_key: 'tab:1:leaf:2',
  delivery_contract: 'audit_only',
  pointer_enter_pending: 2,
  pointer_pty_id: 'pty_1',
  pointer_process_incarnation: 'inc_1',
  answer_sender_snapshot: '{"s":2}'
}

describe('notice message type migration', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('rebuilds a v46 messages table to accept notice, keeping every column, index and the sequence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-notice-migration-'))
    directories.push(directory)
    const path = join(directory, 'orchestration.db')
    new OrchestrationDb(path).close()

    const raw = new Database(path)
    dropDerivedDeliverySchema(raw)
    const indexes = raw
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL"
      )
      .all()
    const namesBefore = textColumnValues(indexes, 'name')
    raw.exec(`
      DROP TABLE messages;
      ${V46_MESSAGES_SQL};
      ${textColumnValues(indexes, 'sql')
        .map((index) => `${index};`)
        .join('\n')}
    `)
    const columns = Object.keys(SAMPLE)
    raw
      .prepare(
        `INSERT INTO messages (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
      )
      .run(...Object.values(SAMPLE))
    // A deleted message's sequence must never be handed out again.
    raw
      .prepare(
        "INSERT INTO messages (id, from_handle, to_handle, subject, sequence) VALUES ('msg_gone', 'a', 'b', 'gone', 40)"
      )
      .run()
    raw.prepare("DELETE FROM messages WHERE id = 'msg_gone'").run()
    raw.pragma('user_version = 46')
    raw.close()

    const db = new OrchestrationDb(path)
    try {
      expect(db.db.prepare("SELECT * FROM messages WHERE id = 'msg_sample'").get()).toEqual(SAMPLE)
      const namesAfter = textColumnValues(
        db.db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL"
          )
          .all(),
        'name'
      )
      expect(namesAfter).toEqual(expect.arrayContaining(namesBefore))
      const notice = db.insertMessage({
        from: 'term_a',
        to: 'term_b',
        subject: 'FYI',
        type: 'notice'
      })
      expect(notice.type).toBe('notice')
      expect(notice.sequence).toBe(41)
    } finally {
      db.close()
    }
  })
})
