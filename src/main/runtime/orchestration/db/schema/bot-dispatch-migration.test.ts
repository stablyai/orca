import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../../../sqlite/sync-database'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'

const runId = 'run_legacy_local'
const NEW_INDEXES = [
  'idx_dispatch_contexts_origin',
  'idx_dispatch_creator_orca_session_id',
  'idx_dispatch_creator_pane_key',
  'idx_bot_requests_send',
  'idx_bot_requests_awaiting',
  'idx_question_threads_awaiting',
  'idx_remote_owned_questions_awaiting',
  'idx_dispatch_contexts_for_message',
  'idx_peer_questions_out_awaiting'
]
const TAKE_COLUMNS = [
  ['bot_requests', 'taken_by'],
  ['bot_requests', 'awaiting'],
  ['question_threads', 'taken_by'],
  ['question_threads', 'awaiting'],
  ['question_threads', 'told'],
  ['remote_owned_questions', 'taken_by'],
  ['remote_owned_questions', 'awaiting'],
  ['remote_owned_questions', 'ended'],
  ['dispatch_contexts', 'for_message_id']
] as const
const BOT_TABLES = [
  'bot_requests',
  'bot_request_outcomes',
  'bot_conversation_acts_for',
  'bot_run_resends'
]

describe('v47-v48 bot dispatch migrations', () => {
  // Use and clean a real temp directory: TMPDIR is absent on Windows CI.
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  function dbPath(): string {
    const root = mkdtempSync(join(tmpdir(), 'orca-bot-dispatch-migration-'))
    tempRoots.push(root)
    return join(root, 'orchestration.db')
  }

  function seedWithDispatch(path: string): string {
    const db = new OrchestrationDb(path)
    const task = db.createTask({ runId, spec: 'seeded' })
    createRootDispatch(db, task.id, 'term_seeded')
    db.close()
    return task.id
  }

  function hasIndex(db: OrchestrationDb, name: string): boolean {
    return !!db.db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name)
  }

  function expectCurrentSchema(path: string, seededTaskId?: string): void {
    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(52)
      expect(db.hasColumn('dispatch_contexts', 'chat_lineage')).toBe(true)
      expect(db.hasColumn('remote_dispatch_attachments', 'chat_lineage')).toBe(true)
      expect(TAKE_COLUMNS.filter(([table, column]) => !db.hasColumn(table, column))).toEqual([])
      expect(db.hasColumn('dispatch_contexts', 'creator_turn_source')).toBe(true)
      expect(db.hasColumn('dispatch_contexts', 'origin_ref')).toBe(true)
      expect(db.hasColumn('bot_requests', 'send_key')).toBe(true)
      expect(NEW_INDEXES.filter((name) => !hasIndex(db, name))).toEqual([])
      if (seededTaskId) {
        expect(db.getDispatchContext(seededTaskId)?.assignee_handle).toBe('term_seeded')
      }
      const task = db.createTask({ runId, spec: 'after open' })
      const dispatch = createRootDispatch(db, task.id, `term_${task.id}`)
      expect(dispatch.creator_turn_source).toBeNull()
      expect(dispatch.origin_ref).toBeNull()
    } finally {
      db.close()
    }
  }

  /** Strip what v47 and v48 add, as a database last opened by a build at v46 has it. */
  function rewindToV46(path: string): void {
    const raw = new Database(path)
    for (const index of NEW_INDEXES) {
      raw.exec(`DROP INDEX IF EXISTS ${index}`)
    }
    raw.exec('ALTER TABLE dispatch_contexts DROP COLUMN origin_ref')
    raw.exec('ALTER TABLE dispatch_contexts DROP COLUMN creator_turn_source')
    for (const table of BOT_TABLES) {
      raw.exec(`DROP TABLE ${table}`)
    }
    raw.pragma('user_version = 46')
    raw.close()
  }

  it('adds who took each question to a v49 database and keeps its rows', () => {
    const path = dbPath()
    const taskId = seedWithDispatch(path)
    const raw = new Database(path)
    for (const index of NEW_INDEXES.slice(4)) {
      raw.exec(`DROP INDEX IF EXISTS ${index}`)
    }
    for (const [table, column] of TAKE_COLUMNS) {
      raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`)
    }
    raw.exec('DROP TABLE peer_questions_out')
    raw.pragma('user_version = 49')
    raw.close()

    expectCurrentSchema(path, taskId)
  })

  it('opens a fresh database at v48, and again unchanged', () => {
    const path = dbPath()
    expectCurrentSchema(path)
    expectCurrentSchema(path)
  })

  it('migrates a v46 database without the bot columns and keeps its rows', () => {
    const path = dbPath()
    const taskId = seedWithDispatch(path)
    rewindToV46(path)

    expectCurrentSchema(path, taskId)
  })

  it('migrates a v46 database that already has the bot columns, indexes and an early bot mail table', () => {
    const path = dbPath()
    const taskId = seedWithDispatch(path)
    const raw = new Database(path)
    // Early bot builds: no 'status' purpose, no send key, one handoff per bot per request.
    raw.exec(`
      DROP INDEX idx_bot_requests_send;
      DROP TABLE bot_requests;
      CREATE TABLE bot_requests (
        message_id  TEXT PRIMARY KEY,
        root_key    TEXT NOT NULL,
        from_bot_id TEXT,
        to_bot_id   TEXT NOT NULL,
        purpose     TEXT NOT NULL CHECK(purpose IN ('handoff', 'question')),
        depth       INTEGER NOT NULL,
        record      TEXT NOT NULL,
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX idx_bot_requests_one_handoff ON bot_requests(root_key, to_bot_id)
        WHERE purpose = 'handoff';
      CREATE TABLE bot_request_roots (root_key TEXT PRIMARY KEY);
      INSERT INTO bot_requests (message_id, root_key, to_bot_id, purpose, depth, record)
        VALUES ('msg_early', 'root_early', 'bot_b', 'handoff', 1, '{}');
    `)
    raw.pragma('user_version = 46')
    raw.close()

    expectCurrentSchema(path, taskId)
    const db = new OrchestrationDb(path)
    try {
      expect(db.db.prepare('SELECT message_id, send_key FROM bot_requests').all()).toEqual([
        { message_id: 'msg_early', send_key: null }
      ])
      db.db.exec(`INSERT INTO bot_requests (message_id, root_key, to_bot_id, purpose, depth, record)
        VALUES ('msg_status', 'root_early', 'bot_b', 'status', 1, '{}')`)
      expect(hasIndex(db, 'idx_bot_requests_one_handoff')).toBe(false)
      expect(
        db.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'bot_request_roots'").get()
      ).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('keeps the bot columns, mail rows and indexes of a v46 database an earlier bots build already shaped', () => {
    const path = dbPath()
    const taskId = seedWithDispatch(path)
    const raw = new Database(path)
    // Earlier bots builds added these unnumbered on every open, leaving user_version at 46.
    raw.exec(`
      UPDATE dispatch_contexts SET creator_turn_source = 'connector', origin_ref = 'item_1';
      INSERT INTO bot_requests (message_id, root_key, to_bot_id, purpose, depth, record, send_key)
        VALUES ('msg_status', 'root_1', 'bot_b', 'status', 1, '{"a":1}', 'send_1');
    `)
    raw.pragma('user_version = 46')
    raw.close()

    expectCurrentSchema(path, taskId)
    const db = new OrchestrationDb(path)
    try {
      expect(
        db.db
          .prepare(
            'SELECT creator_turn_source, origin_ref FROM dispatch_contexts WHERE task_id = ?'
          )
          .get(taskId)
      ).toEqual({ creator_turn_source: 'connector', origin_ref: 'item_1' })
      expect(
        db.db.prepare('SELECT message_id, purpose, record, send_key FROM bot_requests').all()
      ).toEqual([
        { message_id: 'msg_status', purpose: 'status', record: '{"a":1}', send_key: 'send_1' }
      ])
    } finally {
      db.close()
    }
  })

  it('migrates a database an early bot build stamped 47 with only creator_turn_source', () => {
    const path = dbPath()
    const taskId = seedWithDispatch(path)
    const raw = new Database(path)
    raw.exec('DROP INDEX idx_dispatch_contexts_origin')
    raw.exec('ALTER TABLE dispatch_contexts DROP COLUMN origin_ref')
    raw.pragma('user_version = 47')
    raw.close()

    expectCurrentSchema(path, taskId)
  })
})
