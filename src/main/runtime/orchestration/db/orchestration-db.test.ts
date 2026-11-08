import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../../sqlite/sync-database'
import { OrchestrationDb } from './orchestration-db'
import './contract-constants'
import './messages/mailbox-routing-page'
import './dispatch-row-writer'
import './attempt-outcome-projection'
import { ORCHESTRATION_LEGACY_RUN_ID as LEGACY_RUN_ID } from '../../../../shared/orchestration-rpc-contract'
import { createRootDispatch } from './root-dispatch-test-fixture'

const runId = 'run_legacy_local'

describe('OrchestrationDb', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('tasks', () => {
    it('completing a task frees its active dispatch context', () => {
      const d = createDb()
      const task = d.createTask({ runId, spec: 'do it' })
      createRootDispatch(d, task.id, 'term_a')

      d.updateTaskStatus(task.id, 'completed')

      expect(d.getActiveDispatchForTerminal('term_a')).toBeUndefined()
      expect(d.getDispatchContext(task.id)?.status).toBe('completed')
    })
  })

  describe('dispatch contexts', () => {
    // Only the leaf UUID survives pane break-out; the tab portion of paneKey can change.
    const LEAF_A = '11111111-1111-1111-8111-111111111111'
    const LEAF_B = '22222222-2222-4222-9222-222222222222'

    it('rejects dispatch when pane keys share a leaf after break-out', () => {
      const d = createDb()
      const t1 = d.createTask({ runId, spec: 'first' })
      const t2 = d.createTask({ runId, spec: 'second' })
      createRootDispatch(d, t1.id, 'term_old', `tab_1:${LEAF_A}`)

      expect(() => createRootDispatch(d, t2.id, 'term_new', `tab_2:${LEAF_A}`)).toThrow(
        /already has an active dispatch/
      )
    })

    it('allows concurrent dispatches to different panes', () => {
      const d = createDb()
      const t1 = d.createTask({ runId, spec: 'first' })
      const t2 = d.createTask({ runId, spec: 'second' })
      createRootDispatch(d, t1.id, 'term_a', `tab_1:${LEAF_A}`)

      expect(() => createRootDispatch(d, t2.id, 'term_b', `tab_1:${LEAF_B}`)).not.toThrow()
    })

    it('allows dispatch to a terminal after previous dispatch completes', () => {
      const d = createDb()
      const t1 = d.createTask({ runId, spec: 'first' })
      const t2 = d.createTask({ runId, spec: 'second' })
      const ctx1 = createRootDispatch(d, t1.id, 'term_worker')

      d.completeDispatch(ctx1.id)

      expect(() => createRootDispatch(d, t2.id, 'term_worker')).not.toThrow()
    })

    it('getLatestDispatchForTerminal returns the most recent completed dispatch', () => {
      const d = createDb()
      const firstTask = d.createTask({
        runId,
        spec: 'first'
      })
      const first = createRootDispatch(d, firstTask.id, 'term_a')
      d.completeDispatch(first.id)
      const secondTask = d.createTask({
        runId,
        spec: 'second'
      })
      const second = createRootDispatch(d, secondTask.id, 'term_a')
      d.completeDispatch(second.id)

      const latest = d.getLatestDispatchForTerminal('term_a')
      expect(latest?.id).toBe(second.id)
      expect(latest?.status).toBe('completed')
      expect(d.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('circuit breaker trips after 3 failures', () => {
      const d = createDb()
      const task = d.createTask({ runId, spec: 'flaky' })
      const ctx = createRootDispatch(d, task.id, 'term_a')

      const after1 = d.failDispatch(ctx.id, 'timeout')
      expect(after1?.failure_count).toBe(1)
      expect(after1?.status).toBe('failed')
      expect(d.getTask(task.id)?.status).toBe('ready')

      const ctx2 = createRootDispatch(d, task.id, 'term_a')
      const after2 = d.failDispatch(ctx2.id, 'timeout')
      expect(after2?.failure_count).toBe(2)
      expect(after2?.status).toBe('failed')

      const ctx3 = createRootDispatch(d, task.id, 'term_a')
      const after3 = d.failDispatch(ctx3.id, 'timeout')
      expect(after3?.failure_count).toBe(3)
      expect(after3?.status).toBe('circuit_broken')
      expect([after1, after2, after3].every((dispatch) => dispatch?.completed_at)).toBe(true)
      expect(d.getTask(task.id)?.status).toBe('failed')
    })
  })

  describe('decision gates', () => {
    it('creates a gate and blocks the task', () => {
      const d = createDb()
      const task = d.createTask({
        runId,
        spec: 'needs approval'
      })
      createRootDispatch(d, task.id, 'term_a')
      const gate = d.createGate({
        taskId: task.id,
        question: 'Proceed?',
        options: ['yes', 'no']
      })

      expect(gate.id).toMatch(/^gate_/)
      expect(gate.task_id).toBe(task.id)
      expect(gate.status).toBe('pending')
      expect(JSON.parse(gate.options)).toEqual(['yes', 'no'])

      const updated = d.getTask(task.id)
      expect(updated?.status).toBe('blocked')
      expect(d.getActiveDispatchForTerminal('term_a')).toBeUndefined()
    })

    it('rolls back the gate row when the Task transition cannot commit', () => {
      const d = createDb()
      const task = d.createTask({ runId: 'run_legacy_local', spec: 'atomic gate creation' })
      const dispatch = createRootDispatch(d, task.id, 'term_gate')
      d.db.exec(`
        CREATE TRIGGER reject_gate_task_block
        BEFORE UPDATE ON tasks
        WHEN NEW.status = 'blocked'
        BEGIN SELECT RAISE(ABORT, 'forced gate task block failure'); END;
      `)

      expect(() => d.createGate({ taskId: task.id, question: 'Proceed?' })).toThrow(
        'forced gate task block failure'
      )
      expect(d.listGates({ taskId: task.id })).toHaveLength(0)
      expect(d.getTask(task.id)?.status).toBe('dispatched')
      expect(d.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')
    })
  })

  describe('schema migration from v1 → v2', () => {
    let dbPath: string
    let tempDir: string

    afterEach(() => {
      // Close SQLite before recursive cleanup because Windows retains its file lock.
      db?.close()
      db = undefined
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    })

    function createV1Snapshot(): string {
      tempDir = mkdtempSync(join(tmpdir(), 'orca-db-migrate-'))
      dbPath = join(tempDir, 'test.db')
      const raw = new Database(dbPath)
      // v1 schema: pre-heartbeat CHECK, no last_heartbeat_at column.
      raw.exec(`
        CREATE TABLE messages (
          id            TEXT NOT NULL,
          from_handle   TEXT NOT NULL,
          to_handle     TEXT NOT NULL,
          subject       TEXT NOT NULL,
          body          TEXT NOT NULL DEFAULT '',
          type          TEXT NOT NULL DEFAULT 'status'
            CHECK(type IN (
              'status', 'dispatch', 'worker_done', 'merge_ready',
              'escalation', 'handoff', 'decision_gate'
            )),
          priority      TEXT NOT NULL DEFAULT 'normal'
            CHECK(priority IN ('normal', 'high', 'urgent')),
          thread_id     TEXT,
          payload       TEXT,
          read          INTEGER NOT NULL DEFAULT 0,
          sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX idx_messages_id ON messages(id);
        CREATE INDEX idx_inbox ON messages(to_handle, read);
        CREATE INDEX idx_thread ON messages(thread_id);

        CREATE TABLE tasks (
          id TEXT PRIMARY KEY, parent_id TEXT, spec TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','ready','dispatched','completed','failed','blocked')),
          deps TEXT NOT NULL DEFAULT '[]', result TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );

        CREATE TABLE dispatch_contexts (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, assignee_handle TEXT,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','dispatched','completed','failed','circuit_broken')),
          failure_count INTEGER NOT NULL DEFAULT 0, last_failure TEXT,
          dispatched_at TEXT, completed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE decision_gates (
          id TEXT PRIMARY KEY, task_id TEXT NOT NULL, question TEXT NOT NULL,
          options TEXT NOT NULL DEFAULT '[]',
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK(status IN ('pending','resolved','timeout')),
          resolution TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT
        );

        CREATE TABLE coordinator_runs (
          id TEXT PRIMARY KEY, spec TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle'
            CHECK(status IN ('idle','running','completed','failed')),
          coordinator_handle TEXT NOT NULL,
          poll_interval_ms INTEGER NOT NULL DEFAULT 2000,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT
        );
      `)
      // Seed a pre-existing v1 message so migration must preserve data.
      raw
        .prepare(
          `INSERT INTO messages (id, from_handle, to_handle, subject, type) VALUES ('msg_v1', 'a', 'b', 'pre-migration', 'status')`
        )
        .run()
      raw.pragma('user_version = 0')
      raw.close()
      return dbPath
    }

    it('migrates a v1 snapshot to v2, accepts heartbeat, preserves indexes', () => {
      const path = createV1Snapshot()
      const d = new OrchestrationDb(path)
      db = d

      expect(() =>
        d.insertMessage({
          runId,
          from: 'w',
          to: 'c',
          subject: 'alive',
          type: 'heartbeat',
          payload: '{"taskId":"t","dispatchId":"ctx"}'
        })
      ).not.toThrow()

      const task = d.createTask({ runId, spec: 'work' })
      const ctx = createRootDispatch(d, task.id, 'term_a')
      d.recordHeartbeat(ctx.id, '2026-05-04T00:00:00.000Z')
      expect(d.getDispatchContext(task.id)?.last_heartbeat_at).toBe('2026-05-04T00:00:00.000Z')
      expect(d.getTask(task.id)?.task_title).toBe('work')
      expect(d.getTask(task.id)?.display_name).toBe('work')

      const sqlite = (d as unknown as { db: Database.Database }).db
      const indexes = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND name NOT LIKE 'sqlite_%'`
        )
        .all() as { name: string }[]
      const names = new Set(indexes.map((r) => r.name))
      expect(names.has('idx_messages_id')).toBe(true)
      expect(names.has('idx_inbox')).toBe(true)
      expect(names.has('idx_messages_undelivered_inbox')).toBe(true)
      expect(names.has('idx_thread')).toBe(true)

      expect(d.getMessageById('msg_v1')?.subject).toBe('pre-migration')
      expect(d.getMessageById('msg_v1')?.run_id).toBe(d.getLegacyAdoption()?.adopted_run_id)
      expect(d.getRun(LEGACY_RUN_ID)).toMatchObject({ legacy: 1 })
    })
  })
})
