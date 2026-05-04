/* eslint-disable max-lines -- Why: DB tests cover messages, tasks, dispatch contexts, decision gates, coordinator runs, and lifecycle in one suite to share the createDb() helper and afterEach cleanup. */
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
})
