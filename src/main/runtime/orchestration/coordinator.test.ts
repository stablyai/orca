/* eslint-disable max-lines -- Why: coordinator tests cover dispatch, DAG ordering, escalation, decision gates, concurrency, and stop — splitting by category would scatter shared setup without improving clarity. */
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { Coordinator, type CoordinatorRuntime } from './coordinator'

function createMockRuntime(): CoordinatorRuntime & {
  sentMessages: { handle: string; text: string }[]
  terminals: { handle: string; worktreeId: string; connected: boolean; writable: boolean }[]
  createdTerminals: string[]
} {
  const mock = {
    sentMessages: [] as { handle: string; text: string }[],
    terminals: [] as {
      handle: string
      worktreeId: string
      connected: boolean
      writable: boolean
    }[],
    createdTerminals: [] as string[],
    async sendTerminal(handle: string, action: { text?: string }) {
      mock.sentMessages.push({ handle, text: action.text ?? '' })
      return { handle, accepted: true, bytesWritten: 0 }
    },
    async listTerminals() {
      return { terminals: mock.terminals }
    },
    async createTerminal(_worktree?: string, opts?: { title?: string }) {
      const handle = `term_worker_${mock.createdTerminals.length}`
      mock.createdTerminals.push(handle)
      mock.terminals.push({ handle, worktreeId: 'wt1', connected: true, writable: true })
      return { handle, worktreeId: 'wt1', title: opts?.title ?? '' }
    },
    async waitForTerminal(handle: string) {
      return { handle, condition: 'exit' }
    }
  }
  return mock
}

describe('Coordinator', () => {
  let db: OrchestrationDb

  afterEach(() => {
    db?.close()
  })

  it('throws if no tasks exist', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    const coordinator = new Coordinator(db, runtime, {
      spec: 'do stuff',
      coordinatorHandle: 'coord'
    })
    await expect(coordinator.run()).rejects.toThrow('No tasks found')
  })

  it('dispatches a ready task to an available terminal', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const task = db.createTask({ spec: 'implement feature' })

    // Simulate worker_done arriving after dispatch
    const coordinator = new Coordinator(db, runtime, {
      spec: 'build it',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    // Run coordinator in background, then simulate completion
    const runPromise = coordinator.run()

    // Wait for dispatch to happen
    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // Simulate the worker completing
    db.insertMessage({
      from: 'term_a',
      to: 'coord',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id, filesModified: ['a.ts'] })
    })

    const result = await runPromise
    expect(result.status).toBe('completed')
    expect(result.completedTasks).toContain(task.id)
    expect(runtime.sentMessages.length).toBeGreaterThan(0)
  })

  it('creates a terminal when none are available', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()

    const task = db.createTask({ spec: 'work' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    await new Promise((r) => {
      setTimeout(r, 100)
    })

    expect(runtime.createdTerminals.length).toBe(1)

    // Complete the task
    db.insertMessage({
      from: runtime.createdTerminals[0],
      to: 'coord',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id })
    })

    const result = await runPromise
    expect(result.status).toBe('completed')
  })

  it('handles escalation and circuit breaker', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [
      { handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true },
      { handle: 'term_b', worktreeId: 'wt1', connected: true, writable: true }
    ]

    const task = db.createTask({ spec: 'risky work' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    // Send 3 escalations to trigger circuit breaker
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => {
        setTimeout(r, 100)
      })
      db.insertMessage({
        from: `term_${i === 0 ? 'a' : 'b'}`,
        to: 'coord',
        subject: `Failed attempt ${i + 1}`,
        type: 'escalation',
        payload: JSON.stringify({ taskId: task.id })
      })
    }

    const result = await runPromise
    expect(result.status).toBe('failed')
    expect(result.failedTasks).toContain(task.id)
  })

  it('reports failed when dispatch send failures circuit-break in the DB', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]
    runtime.sendTerminal = async () => {
      throw new Error('terminal_not_writable')
    }

    const task = db.createTask({ spec: 'cannot dispatch' })
    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 10
    })

    const result = await coordinator.run()

    expect(result.status).toBe('failed')
    expect(result.failedTasks).toContain(task.id)
    expect(db.getTask(task.id)?.status).toBe('failed')
  })

  it('handles decision gate blocking and resolution', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const task = db.createTask({ spec: 'needs approval' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    // Wait for dispatch
    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // Worker sends decision gate
    db.insertMessage({
      from: 'term_a',
      to: 'coord',
      subject: 'Need approval',
      type: 'decision_gate',
      payload: JSON.stringify({
        taskId: task.id,
        question: 'Proceed with destructive migration?',
        options: ['yes', 'no']
      })
    })

    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // Verify task is blocked
    const blocked = db.getTask(task.id)
    expect(blocked?.status).toBe('blocked')
    expect(db.getActiveDispatchForTerminal('term_a')).toBeUndefined()

    // Resolve the gate
    const gates = db.listGates({ taskId: task.id, status: 'pending' })
    expect(gates.length).toBe(1)
    db.resolveGate(gates[0].id, 'yes')

    // Wait for re-dispatch and simulate completion
    await new Promise((r) => {
      setTimeout(r, 200)
    })

    db.insertMessage({
      from: 'term_a',
      to: 'coord',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: task.id })
    })

    const result = await runPromise
    expect(result.status).toBe('completed')
    expect(result.completedTasks).toContain(task.id)
  })

  it('respects task DAG ordering', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [{ handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true }]

    const t1 = db.createTask({ spec: 'first' })
    const t2 = db.createTask({ spec: 'second', deps: [t1.id] })

    expect(t2.status).toBe('pending')

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    // Wait for t1 dispatch
    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // t2 should still be pending
    expect(db.getTask(t2.id)?.status).toBe('pending')

    // Complete t1
    db.insertMessage({
      from: 'term_a',
      to: 'coord',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: t1.id })
    })

    // Wait for t2 to be promoted and dispatched
    await new Promise((r) => {
      setTimeout(r, 200)
    })

    // t2 should now be dispatched
    const t2Status = db.getTask(t2.id)?.status
    expect(t2Status === 'dispatched' || t2Status === 'ready').toBe(true)

    // Complete t2
    db.insertMessage({
      from: 'term_a',
      to: 'coord',
      subject: 'Done',
      type: 'worker_done',
      payload: JSON.stringify({ taskId: t2.id })
    })

    const result = await runPromise
    expect(result.status).toBe('completed')
    expect(result.completedTasks).toContain(t1.id)
    expect(result.completedTasks).toContain(t2.id)
  })

  it('respects maxConcurrent limit', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    runtime.terminals = [
      { handle: 'term_a', worktreeId: 'wt1', connected: true, writable: true },
      { handle: 'term_b', worktreeId: 'wt1', connected: true, writable: true },
      { handle: 'term_c', worktreeId: 'wt1', connected: true, writable: true }
    ]

    const t1 = db.createTask({ spec: 'one' })
    const t2 = db.createTask({ spec: 'two' })
    const t3 = db.createTask({ spec: 'three' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50,
      maxConcurrent: 2
    })

    const runPromise = coordinator.run()

    await new Promise((r) => {
      setTimeout(r, 100)
    })

    // Only 2 should be dispatched
    const dispatched = db.listTasks({ status: 'dispatched' })
    expect(dispatched.length).toBe(2)

    // Complete all tasks
    for (const task of [t1, t2, t3]) {
      db.insertMessage({
        from: 'term_a',
        to: 'coord',
        subject: 'Done',
        type: 'worker_done',
        payload: JSON.stringify({ taskId: task.id })
      })
      await new Promise((r) => {
        setTimeout(r, 100)
      })
    }

    const result = await runPromise
    expect(result.status).toBe('completed')
  })

  it('can be stopped', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = createMockRuntime()
    db.createTask({ spec: 'never finishes' })

    const coordinator = new Coordinator(db, runtime, {
      spec: 'go',
      coordinatorHandle: 'coord',
      pollIntervalMs: 50
    })

    const runPromise = coordinator.run()

    await new Promise((r) => {
      setTimeout(r, 100)
    })
    coordinator.stop()

    const result = await runPromise
    expect(result.status).toBe('failed')
  })
})
