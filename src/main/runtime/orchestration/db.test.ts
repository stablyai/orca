/* eslint-disable max-lines -- Why: DB tests cover messages, tasks, dispatch contexts, decision gates, coordinator runs, and lifecycle in one suite to share the createDb() helper and afterEach cleanup. */
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { MessageType } from './db'

describe('OrchestrationDb', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('messages', () => {
    it('inserts and retrieves a message', () => {
      const d = createDb()
      const msg = d.insertMessage({
        from: 'term_a',
        to: 'term_b',
        subject: 'hello',
        body: 'world'
      })
      expect(msg.id).toMatch(/^msg_/)
      expect(msg.from_handle).toBe('term_a')
      expect(msg.to_handle).toBe('term_b')
      expect(msg.subject).toBe('hello')
      expect(msg.body).toBe('world')
      expect(msg.type).toBe('status')
      expect(msg.priority).toBe('normal')
      expect(msg.read).toBe(0)
      expect(msg.sequence).toBeGreaterThan(0)
    })

    it('returns unread messages in sequence order', () => {
      const d = createDb()
      d.insertMessage({ from: 'a', to: 'b', subject: 'first' })
      d.insertMessage({ from: 'a', to: 'b', subject: 'second' })
      d.insertMessage({ from: 'a', to: 'c', subject: 'other' })

      const unread = d.getUnreadMessages('b')
      expect(unread).toHaveLength(2)
      expect(unread[0].subject).toBe('first')
      expect(unread[1].subject).toBe('second')
    })

    it('filters unread by type', () => {
      const d = createDb()
      d.insertMessage({ from: 'a', to: 'b', subject: 'status msg', type: 'status' })
      d.insertMessage({ from: 'a', to: 'b', subject: 'done msg', type: 'worker_done' })

      const filtered = d.getUnreadMessages('b', ['worker_done'])
      expect(filtered).toHaveLength(1)
      expect(filtered[0].type).toBe('worker_done')
    })

    it('excludes already-delivered rows from getUndeliveredUnreadMessages', () => {
      const d = createDb()
      const m1 = d.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      const m2 = d.insertMessage({ from: 'a', to: 'b', subject: 'two' })

      d.markAsDelivered([m1.id])

      // Push delivery query: only undelivered, unread.
      const pending = d.getUndeliveredUnreadMessages('b')
      expect(pending).toHaveLength(1)
      expect(pending[0].id).toBe(m2.id)

      // Explicit `check` still sees both (they are still unread).
      const unread = d.getUnreadMessages('b')
      expect(unread).toHaveLength(2)
    })

    it('creates the undelivered inbox index used by push delivery', () => {
      const d = createDb()
      const sqlite = (d as unknown as { db: Database.Database }).db

      const indexes = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND name = 'idx_messages_undelivered_inbox'`
        )
        .all()

      expect(indexes).toHaveLength(1)
    })

    it('filters getUndeliveredUnreadMessages by type', () => {
      const d = createDb()
      d.insertMessage({ from: 'a', to: 'b', subject: 's', type: 'status' })
      const wd = d.insertMessage({ from: 'a', to: 'b', subject: 'd', type: 'worker_done' })

      const filtered = d.getUndeliveredUnreadMessages('b', ['worker_done'])
      expect(filtered).toHaveLength(1)
      expect(filtered[0].id).toBe(wd.id)
    })

    it('marks messages as read', () => {
      const d = createDb()
      const m1 = d.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      const m2 = d.insertMessage({ from: 'a', to: 'b', subject: 'two' })

      d.markAsRead([m1.id])

      const unread = d.getUnreadMessages('b')
      expect(unread).toHaveLength(1)
      expect(unread[0].id).toBe(m2.id)
    })

    it('stores typed payload and thread_id', () => {
      const d = createDb()
      const payload = JSON.stringify({ taskId: 'task_abc', filesModified: ['src/a.ts'] })
      const msg = d.insertMessage({
        from: 'a',
        to: 'b',
        subject: 'done',
        type: 'worker_done',
        priority: 'high',
        threadId: 'thread_1',
        payload
      })

      expect(msg.type).toBe('worker_done')
      expect(msg.priority).toBe('high')
      expect(msg.thread_id).toBe('thread_1')
      expect(msg.payload).toBe(payload)
    })

    it('rejects invalid message type', () => {
      const d = createDb()
      expect(() =>
        d.insertMessage({
          from: 'a',
          to: 'b',
          subject: 'bad',
          type: 'invalid' as MessageType
        })
      ).toThrow()
    })

    it('getInbox returns all messages across recipients', () => {
      const d = createDb()
      d.insertMessage({ from: 'a', to: 'b', subject: 'one' })
      d.insertMessage({ from: 'a', to: 'c', subject: 'two' })
      d.insertMessage({ from: 'b', to: 'a', subject: 'three' })

      const inbox = d.getInbox(10)
      expect(inbox).toHaveLength(3)
    })

    it('getMessageById returns the correct message', () => {
      const d = createDb()
      const msg = d.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      const found = d.getMessageById(msg.id)
      expect(found?.subject).toBe('test')
      expect(d.getMessageById('msg_nonexistent')).toBeUndefined()
    })
  })

  describe('tasks', () => {
    it('creates a task with no deps as ready', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'do something' })
      expect(task.id).toMatch(/^task_/)
      expect(task.status).toBe('ready')
      expect(task.deps).toBe('[]')
    })

    it('persists the creating terminal handle for task-created worktrees', () => {
      const d = createDb()
      const task = d.createTask({
        spec: 'spawn related workspace',
        createdByTerminalHandle: 'term_creator'
      })

      expect(task.created_by_terminal_handle).toBe('term_creator')
      expect(d.getTask(task.id)?.created_by_terminal_handle).toBe('term_creator')
    })

    it('creates a task with deps as pending', () => {
      const d = createDb()
      const parent = d.createTask({ spec: 'parent' })
      const child = d.createTask({ spec: 'child', deps: [parent.id] })
      expect(child.status).toBe('pending')
      expect(JSON.parse(child.deps)).toEqual([parent.id])
    })

    it('promotes pending tasks when deps complete', () => {
      const d = createDb()
      const t1 = d.createTask({ spec: 'first' })
      const t2 = d.createTask({ spec: 'second', deps: [t1.id] })

      expect(d.getTask(t2.id)?.status).toBe('pending')

      d.updateTaskStatus(t1.id, 'completed')

      expect(d.getTask(t2.id)?.status).toBe('ready')
    })

    it('does not promote task until ALL deps complete', () => {
      const d = createDb()
      const t1 = d.createTask({ spec: 'a' })
      const t2 = d.createTask({ spec: 'b' })
      const t3 = d.createTask({ spec: 'c', deps: [t1.id, t2.id] })

      d.updateTaskStatus(t1.id, 'completed')
      expect(d.getTask(t3.id)?.status).toBe('pending')

      d.updateTaskStatus(t2.id, 'completed')
      expect(d.getTask(t3.id)?.status).toBe('ready')
    })

    it('sets completed_at on completion', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'do it' })
      const updated = d.updateTaskStatus(task.id, 'completed', '{"result": true}')
      expect(updated?.completed_at).toBeTruthy()
      expect(updated?.result).toBe('{"result": true}')
    })

    it('completing a task frees its active dispatch context', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'do it' })
      d.createDispatchContext(task.id, 'term_a')

      d.updateTaskStatus(task.id, 'completed')

      expect(d.getActiveDispatchForTerminal('term_a')).toBeUndefined()
      expect(d.getDispatchContext(task.id)?.status).toBe('completed')
    })

    it('listTasks filters by status', () => {
      const d = createDb()
      d.createTask({ spec: 'ready task' })
      const t2 = d.createTask({ spec: 'another' })
      d.updateTaskStatus(t2.id, 'completed')

      expect(d.listTasks({ status: 'ready' })).toHaveLength(1)
      expect(d.listTasks({ status: 'completed' })).toHaveLength(1)
      expect(d.listTasks({ ready: true })).toHaveLength(1)
    })

    it('listTasks returns all when no filter', () => {
      const d = createDb()
      d.createTask({ spec: 'one' })
      d.createTask({ spec: 'two' })
      expect(d.listTasks()).toHaveLength(2)
    })

    it('listTasksWithDispatch joins active dispatch metadata', () => {
      const d = createDb()
      const ready = d.createTask({ spec: 'ready task' })
      const dispatched = d.createTask({ spec: 'active task' })
      const ctx = d.createDispatchContext(dispatched.id, 'term_worker')

      const rows = d.listTasksWithDispatch()
      const readyRow = rows.find((r) => r.id === ready.id)
      const dispatchedRow = rows.find((r) => r.id === dispatched.id)

      expect(readyRow?.assignee_handle).toBeNull()
      expect(readyRow?.dispatch_id).toBeNull()
      expect(dispatchedRow?.assignee_handle).toBe('term_worker')
      expect(dispatchedRow?.dispatch_id).toBe(ctx.id)
    })

    it('listTasksWithDispatch does not surface completed dispatches', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      d.createDispatchContext(task.id, 'term_worker')
      d.updateTaskStatus(task.id, 'completed')

      const rows = d.listTasksWithDispatch()
      const row = rows.find((r) => r.id === task.id)
      // Task is completed — its dispatch is terminal and should not appear as
      // an "active" assignee.
      expect(row?.assignee_handle).toBeNull()
      expect(row?.dispatch_id).toBeNull()
    })

    it('supports parent_id for task decomposition', () => {
      const d = createDb()
      const parent = d.createTask({ spec: 'parent' })
      const child = d.createTask({ spec: 'child', parentId: parent.id })
      expect(child.parent_id).toBe(parent.id)
    })
  })

  describe('dispatch contexts', () => {
    it('creates a dispatch context and marks task as dispatched', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'term_worker')

      expect(ctx.id).toMatch(/^ctx_/)
      expect(ctx.task_id).toBe(task.id)
      expect(ctx.assignee_handle).toBe('term_worker')
      expect(ctx.status).toBe('dispatched')
      expect(d.getTask(task.id)?.status).toBe('dispatched')
    })

    it('rejects dispatch for non-ready tasks', () => {
      const d = createDb()
      const parent = d.createTask({ spec: 'parent' })
      const child = d.createTask({ spec: 'child', deps: [parent.id] })

      expect(() => d.createDispatchContext(child.id, 'term_worker')).toThrow(
        /only ready tasks can be dispatched/
      )
    })

    it('rejects dispatch to an occupied terminal', () => {
      const d = createDb()
      const t1 = d.createTask({ spec: 'first' })
      const t2 = d.createTask({ spec: 'second' })
      d.createDispatchContext(t1.id, 'term_worker')

      expect(() => d.createDispatchContext(t2.id, 'term_worker')).toThrow(
        /already has an active dispatch/
      )
    })

    it('allows dispatch to a terminal after previous dispatch completes', () => {
      const d = createDb()
      const t1 = d.createTask({ spec: 'first' })
      const t2 = d.createTask({ spec: 'second' })
      const ctx1 = d.createDispatchContext(t1.id, 'term_worker')

      d.completeDispatch(ctx1.id)

      expect(() => d.createDispatchContext(t2.id, 'term_worker')).not.toThrow()
    })

    it('getDispatchContext returns latest for a task', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'term_a')
      const found = d.getDispatchContext(task.id)
      expect(found?.id).toBe(ctx.id)
    })

    it('getDispatchContext uses insertion order when timestamps tie', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx1 = d.createDispatchContext(task.id, 'term_a')
      d.failDispatch(ctx1.id, 'retry')
      const ctx2 = d.createDispatchContext(task.id, 'term_a')

      expect(d.getDispatchContext(task.id)?.id).toBe(ctx2.id)
    })

    it('getActiveDispatchForTerminal returns active dispatch', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      d.createDispatchContext(task.id, 'term_a')

      const active = d.getActiveDispatchForTerminal('term_a')
      expect(active?.task_id).toBe(task.id)
      expect(d.getActiveDispatchForTerminal('term_b')).toBeUndefined()
    })

    it('circuit breaker trips after 3 failures', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'flaky' })
      const ctx = d.createDispatchContext(task.id, 'term_a')

      const after1 = d.failDispatch(ctx.id, 'timeout')
      expect(after1?.failure_count).toBe(1)
      expect(after1?.status).toBe('failed')
      expect(d.getTask(task.id)?.status).toBe('ready')

      const ctx2 = d.createDispatchContext(task.id, 'term_a')
      const after2 = d.failDispatch(ctx2.id, 'timeout')
      expect(after2?.failure_count).toBe(2)
      expect(after2?.status).toBe('failed')

      const ctx3 = d.createDispatchContext(task.id, 'term_a')
      const after3 = d.failDispatch(ctx3.id, 'timeout')
      expect(after3?.failure_count).toBe(3)
      expect(after3?.status).toBe('circuit_broken')
      expect(d.getTask(task.id)?.status).toBe('failed')
    })

    it('completeDispatch sets completed_at', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'term_a')
      d.completeDispatch(ctx.id)

      const updated = d.getDispatchContext(task.id)
      expect(updated?.status).toBe('completed')
      expect(updated?.completed_at).toBeTruthy()
    })
  })

  describe('decision gates', () => {
    it('creates a gate and blocks the task', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'needs approval' })
      d.createDispatchContext(task.id, 'term_a')
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

    it('resolves a gate and unblocks the task', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const gate = d.createGate({ taskId: task.id, question: 'ok?' })

      const resolved = d.resolveGate(gate.id, 'yes')
      expect(resolved?.status).toBe('resolved')
      expect(resolved?.resolution).toBe('yes')

      const updated = d.getTask(task.id)
      expect(updated?.status).toBe('ready')
    })

    it('times out a gate', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const gate = d.createGate({ taskId: task.id, question: 'ok?' })

      const timedOut = d.timeoutGate(gate.id)
      expect(timedOut?.status).toBe('timeout')
    })

    it('lists gates with filters', () => {
      const d = createDb()
      const t1 = d.createTask({ spec: 'a' })
      const t2 = d.createTask({ spec: 'b' })
      d.createGate({ taskId: t1.id, question: 'q1' })
      const g2 = d.createGate({ taskId: t2.id, question: 'q2' })
      d.resolveGate(g2.id, 'done')

      expect(d.listGates()).toHaveLength(2)
      expect(d.listGates({ status: 'pending' })).toHaveLength(1)
      expect(d.listGates({ taskId: t1.id })).toHaveLength(1)
      expect(d.listGates({ taskId: t2.id, status: 'resolved' })).toHaveLength(1)
    })

    it('returns undefined for nonexistent gate', () => {
      const d = createDb()
      expect(d.resolveGate('gate_fake', 'yes')).toBeUndefined()
    })
  })

  describe('coordinator runs', () => {
    it('creates and retrieves a coordinator run', () => {
      const d = createDb()
      const run = d.createCoordinatorRun({
        spec: 'build feature',
        coordinatorHandle: 'coord',
        pollIntervalMs: 1000
      })

      expect(run.id).toMatch(/^run_/)
      expect(run.status).toBe('running')
      expect(run.coordinator_handle).toBe('coord')
      expect(run.poll_interval_ms).toBe(1000)
    })

    it('updates coordinator run status', () => {
      const d = createDb()
      const run = d.createCoordinatorRun({
        spec: 'work',
        coordinatorHandle: 'coord'
      })

      const updated = d.updateCoordinatorRun(run.id, 'completed')
      expect(updated?.status).toBe('completed')
      expect(updated?.completed_at).not.toBeNull()
    })

    it('finds active coordinator run', () => {
      const d = createDb()
      expect(d.getActiveCoordinatorRun()).toBeUndefined()

      const run = d.createCoordinatorRun({
        spec: 'work',
        coordinatorHandle: 'coord'
      })

      expect(d.getActiveCoordinatorRun()?.id).toBe(run.id)

      d.updateCoordinatorRun(run.id, 'completed')
      expect(d.getActiveCoordinatorRun()).toBeUndefined()
    })
  })

  describe('lifecycle', () => {
    it('resetAll clears all tables', () => {
      const d = createDb()
      d.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      d.createTask({ spec: 'work' })

      d.resetAll()

      expect(d.getInbox()).toHaveLength(0)
      expect(d.listTasks()).toHaveLength(0)
    })

    it('resetMessages clears only messages', () => {
      const d = createDb()
      d.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      d.createTask({ spec: 'work' })

      d.resetMessages()

      expect(d.getInbox()).toHaveLength(0)
      expect(d.listTasks()).toHaveLength(1)
    })

    it('resetTasks clears tasks and dispatch contexts', () => {
      const d = createDb()
      d.insertMessage({ from: 'a', to: 'b', subject: 'test' })
      const task = d.createTask({ spec: 'work' })
      d.createDispatchContext(task.id, 'term_a')

      d.resetTasks()

      expect(d.getInbox()).toHaveLength(1)
      expect(d.listTasks()).toHaveLength(0)
    })
  })

  describe('heartbeat + thread helpers (fresh schema)', () => {
    it('insertMessage accepts type = heartbeat', () => {
      const d = createDb()
      const msg = d.insertMessage({
        from: 'worker',
        to: 'coord',
        subject: 'alive',
        type: 'heartbeat',
        payload: JSON.stringify({ taskId: 'task_x', dispatchId: 'ctx_x' })
      })
      expect(msg.type).toBe('heartbeat')
    })

    it('recordHeartbeat updates last_heartbeat_at on dispatched rows', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'term_a')

      d.recordHeartbeat(ctx.id, '2026-05-04T00:00:00.000Z')
      const after = d.getDispatchContext(task.id)
      expect(after?.last_heartbeat_at).toBe('2026-05-04T00:00:00.000Z')
    })

    it('recordHeartbeat is a no-op for completed rows (straggler ignored)', () => {
      const d = createDb()
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'term_a')
      d.completeDispatch(ctx.id)

      d.recordHeartbeat(ctx.id, '2026-05-04T00:00:00.000Z')
      const after = d.getDispatchContext(task.id)
      expect(after?.last_heartbeat_at).toBeNull()
    })

    it('getStaleDispatches returns only dispatched rows past the grace window', () => {
      const d = createDb()
      // Fixture: four rows, SQL-backdated timestamps (no fake clock):
      //  (a) dispatched, heartbeated 5 min ago → not stale
      //  (b) dispatched, heartbeated 12 min ago → STALE (expected result)
      //  (c) dispatched, never heartbeated, dispatched 30s ago → not stale (grace)
      //  (d) completed, heartbeated 30 min ago → not stale (status filter)
      const taskA = d.createTask({ spec: 'a' })
      const taskB = d.createTask({ spec: 'b' })
      const taskC = d.createTask({ spec: 'c' })
      const taskD = d.createTask({ spec: 'd' })
      const ctxA = d.createDispatchContext(taskA.id, 'term_a')
      const ctxB = d.createDispatchContext(taskB.id, 'term_b')
      const ctxC = d.createDispatchContext(taskC.id, 'term_c')
      const ctxD = d.createDispatchContext(taskD.id, 'term_d')
      d.completeDispatch(ctxD.id)

      const now = Date.now()
      const iso = (ms: number) => new Date(now - ms).toISOString()

      // Backdate dispatched_at for a, b, d to long ago so the grace doesn't
      // shield them. c keeps its default (≈now).
      const sqlite = (d as unknown as { db: Database.Database }).db
      sqlite
        .prepare(
          'UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?'
        )
        .run(iso(60 * 60 * 1000), iso(5 * 60 * 1000), ctxA.id)
      sqlite
        .prepare(
          'UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?'
        )
        .run(iso(60 * 60 * 1000), iso(12 * 60 * 1000), ctxB.id)
      sqlite
        .prepare('UPDATE dispatch_contexts SET dispatched_at = ? WHERE id = ?')
        .run(iso(30_000), ctxC.id)
      sqlite
        .prepare(
          'UPDATE dispatch_contexts SET dispatched_at = ?, last_heartbeat_at = ? WHERE id = ?'
        )
        .run(iso(60 * 60 * 1000), iso(30 * 60 * 1000), ctxD.id)

      const stale = d.getStaleDispatches(iso(10 * 60 * 1000))
      expect(stale.map((s) => s.id)).toEqual([ctxB.id])
    })

    it('getThreadMessagesFor returns only same-thread replies to a handle', () => {
      const d = createDb()
      const outbound = d.insertMessage({
        from: 'worker',
        to: 'coord',
        subject: 'Question',
        type: 'decision_gate',
        body: 'yes or no?'
      })
      // Reply in the same thread addressed to the worker
      const reply = d.insertMessage({
        from: 'coord',
        to: 'worker',
        subject: 'Re: Question',
        body: 'yes',
        threadId: outbound.id
      })
      // Distractor: different thread, same recipient
      d.insertMessage({
        from: 'coord',
        to: 'worker',
        subject: 'other',
        body: 'unrelated',
        threadId: 'thread_other'
      })
      // Distractor: same thread but not addressed to worker
      d.insertMessage({
        from: 'coord',
        to: 'someone_else',
        subject: 'cc',
        body: 'not yours',
        threadId: outbound.id
      })

      const replies = d.getThreadMessagesFor(outbound.id, 'worker', outbound.sequence)
      expect(replies).toHaveLength(1)
      expect(replies[0].id).toBe(reply.id)
    })
  })

  describe('schema migration from v1 → v2', () => {
    let dbPath: string
    let tempDir: string

    afterEach(() => {
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

      // (a) INSERT type='heartbeat' now succeeds
      expect(() =>
        d.insertMessage({
          from: 'w',
          to: 'c',
          subject: 'alive',
          type: 'heartbeat',
          payload: '{"taskId":"t","dispatchId":"ctx"}'
        })
      ).not.toThrow()

      // (b) last_heartbeat_at column exists on dispatch_contexts
      const task = d.createTask({ spec: 'work' })
      const ctx = d.createDispatchContext(task.id, 'term_a')
      d.recordHeartbeat(ctx.id, '2026-05-04T00:00:00.000Z')
      expect(d.getDispatchContext(task.id)?.last_heartbeat_at).toBe('2026-05-04T00:00:00.000Z')

      // (c) Indexes still attached to messages post-rebuild.
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

      // v1 data preserved
      expect(d.getMessageById('msg_v1')?.subject).toBe('pre-migration')
    })

    it('is idempotent: opening an already-migrated DB is a no-op', () => {
      const path = createV1Snapshot()
      const first = new OrchestrationDb(path)
      first.insertMessage({
        from: 'w',
        to: 'c',
        subject: 'alive',
        type: 'heartbeat',
        payload: '{}'
      })
      first.close()

      const second = new OrchestrationDb(path)
      db = second
      expect(() =>
        second.insertMessage({
          from: 'w',
          to: 'c',
          subject: 'again',
          type: 'heartbeat',
          payload: '{}'
        })
      ).not.toThrow()
      const inbox = second.getInbox(10)
      expect(inbox.length).toBeGreaterThanOrEqual(2)
    })
  })
})
