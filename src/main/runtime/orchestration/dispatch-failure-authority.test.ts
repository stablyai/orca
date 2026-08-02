import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

function getRawDb(db: OrchestrationDb): {
  prepare(sql: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown }
} {
  const rawDb = (
    db as unknown as {
      db: {
        prepare(sql: string): { run(...args: unknown[]): void; get(...args: unknown[]): unknown }
      }
    }
  ).db
  return rawDb
}

function setLegacyTaskState(
  db: OrchestrationDb,
  taskId: string,
  status: 'pending' | 'ready' | 'blocked' | 'completed' | 'failed',
  result: string | null,
  completedAt: string | null
): void {
  getRawDb(db)
    .prepare('UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?')
    .run(status, result, completedAt, taskId)
}

describe('dispatch failure authority', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('fails the current dispatched attempt and settles dispatched attempt only when current', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'current failure' })
    const dispatch = d.createDispatchContext(task.id, 'term-current')

    expect(d.failDispatchWithDisposition(dispatch.id, 'first failure')).toMatchObject({
      taskTransitionApplied: true,
      dispatch: { status: 'failed', failure_count: 1 }
    })
    expect(d.getTask(task.id)?.status).toBe('ready')
  })

  it('retires an active dispatch when its task becomes pending', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'pending current failure' })
    const dispatch = d.createDispatchContext(task.id, 'term-pending')
    setLegacyTaskState(d, task.id, 'pending', null, null)

    expect(d.getTask(task.id)?.status).toBe('pending')
    expect(d.failDispatchWithDisposition(dispatch.id, 'start failure')).toMatchObject({
      taskTransitionApplied: false,
      dispatch: { status: 'failed', failure_count: 0 }
    })
    expect(d.getTask(task.id)?.status).toBe('pending')
  })

  it('trips the current-attempt circuit breaker on the third failure', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'circuit breaker' })

    for (let failure = 1; failure <= 3; failure += 1) {
      const dispatch = d.createDispatchContext(task.id, `term-${failure}`)
      const settlement = d.failDispatchWithDisposition(dispatch.id, `failure ${failure}`)
      expect(settlement.taskTransitionApplied).toBe(true)
      expect(settlement.dispatch?.failure_count).toBe(failure)
    }

    expect(d.getDispatchContext(task.id)?.status).toBe('circuit_broken')
    expect(d.getTask(task.id)?.status).toBe('failed')
  })

  it('preserves the replacement dispatch after a superseded failure', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'superseded failure' })
    const first = d.createDispatchContext(task.id, 'term-a')
    d.updateTaskStatus(task.id, 'ready')
    const replacement = d.createDispatchContext(task.id, 'term-b')

    expect(d.failDispatchWithDisposition(first.id, 'late failure')).toMatchObject({
      taskTransitionApplied: false,
      dispatch: { status: 'failed', failure_count: 0 }
    })
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getDispatchContextById(replacement.id)).toMatchObject({ status: 'dispatched' })
  })

  function assertInactiveTask(taskStatus: 'ready' | 'blocked'): void {
    const d = createDb()
    const task = d.createTask({ spec: `${taskStatus} task` })
    const dispatch = d.createDispatchContext(task.id, 'term-inactive')
    d.updateTaskStatus(task.id, taskStatus)

    expect(d.failDispatchWithDisposition(dispatch.id, 'inactive failure')).toMatchObject({
      taskTransitionApplied: false,
      dispatch: { status: 'failed', failure_count: 0 }
    })
    expect(d.getTask(task.id)?.status).toBe(taskStatus)
  }

  it('preserves ready task', () => {
    assertInactiveTask('ready')
  })

  it('preserves blocked task', () => {
    assertInactiveTask('blocked')
  })

  it.each([
    ['pending', null, null, 'pending'],
    ['pending', null, null, 'dispatched'],
    ['ready', null, null, 'pending'],
    ['ready', null, null, 'dispatched'],
    ['blocked', 'gate-context', null, 'pending'],
    ['blocked', 'gate-context', null, 'dispatched'],
    ['completed', 'replacement result', '2026-01-01T00:00:00.000Z', 'pending'],
    ['completed', 'replacement result', '2026-01-01T00:00:00.000Z', 'dispatched'],
    ['failed', 'failed result', '2026-01-02T00:00:00.000Z', 'pending'],
    ['failed', 'failed result', '2026-01-02T00:00:00.000Z', 'dispatched']
  ] as const)(
    'legacy active task-state matrix (task=%s, result=%s, completedAt=%s, dispatch=%s)',
    (status, result, completedAt, dispatchStatus) => {
      const d = createDb()
      const task = d.createTask({ spec: `legacy ${status} task` })
      const dispatch = d.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {}
      }).dispatch
      const rawDb = getRawDb(d)
      rawDb
        .prepare(
          `UPDATE dispatch_contexts
           SET status = ?, assignee_handle = 'term-legacy-a', capability_hash = 'cap-a'
           WHERE id = ?`
        )
        .run(dispatchStatus, dispatch.id)
      rawDb
        .prepare(
          `UPDATE worker_dispatches
           SET state = 'start_unknown', stage = 'legacy_start', last_error = 'legacy start uncertain'
           WHERE dispatch_id = ?`
        )
        .run(dispatch.id)
      const replacementStatus =
        status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'dispatched'
      rawDb
        .prepare(
          `INSERT INTO dispatch_contexts
            (id, run_id, task_id, assignee_handle, capability_hash, status, failure_count, dispatched_at, completed_at)
           SELECT ?, run_id, task_id, 'term-legacy-b', 'cap-b', ?, failure_count, datetime('now'), ?
           FROM dispatch_contexts WHERE id = ?`
        )
        .run(
          `ctx-legacy-b-${status}-${dispatchStatus}`,
          replacementStatus,
          replacementStatus === 'dispatched' ? null : completedAt,
          dispatch.id
        )
      if (status === 'blocked') {
        rawDb
          .prepare(
            `INSERT INTO decision_gates (id, task_id, question, status)
             VALUES (?, ?, 'legacy gate context', 'pending')`
          )
          .run(`gate-legacy-${dispatchStatus}`, task.id)
      }
      setLegacyTaskState(d, task.id, status, result, completedAt)

      const before = d.getTask(task.id)
      expect(d.failDispatchWithDisposition(dispatch.id, 'late legacy failure')).toMatchObject({
        taskTransitionApplied: false,
        dispatch: { status: 'failed', failure_count: 0 }
      })
      expect(d.getTask(task.id)).toMatchObject({
        status,
        result: before?.result,
        completed_at: before?.completed_at
      })
      expect(d.getDispatchContextById(dispatch.id)).toMatchObject({
        status: 'failed',
        last_failure: 'late legacy failure',
        completed_at: expect.any(String),
        capability_revoked_at: expect.any(String),
        failure_count: 0
      })
      expect(d.getWorkerDispatch(dispatch.id)).toMatchObject({
        state: 'start_unknown',
        stage: 'legacy_start',
        last_error: 'legacy start uncertain'
      })
      expect(d.getDispatchContextById(`ctx-legacy-b-${status}-${dispatchStatus}`)).toMatchObject({
        status: replacementStatus
      })
      db = undefined
      d.close()
    }
  )

  it('preserves completed gate retirement semantics', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'completed gate retirement' })
    const first = d.createDispatchContext(task.id, 'term-gate-pending')
    const rawDb = (
      d as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): void } }
      }
    ).db
    rawDb.prepare('UPDATE dispatch_contexts SET status = ? WHERE id = ?').run('pending', first.id)
    rawDb.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('ready', task.id)
    rawDb
      .prepare(
        `INSERT INTO dispatch_contexts
          (id, run_id, task_id, contract_version, assignee_handle, status, failure_count, dispatched_at)
         SELECT 'ctx-gate-dispatched', run_id, task_id, contract_version, 'term-gate-dispatched',
           'dispatched', failure_count, datetime('now') FROM dispatch_contexts WHERE id = ?`
      )
      .run(first.id)

    const gate = d.createGate({ taskId: task.id, question: 'Continue?' })
    expect(gate.status).toBe('pending')
    expect(d.getTask(task.id)?.status).toBe('blocked')
    expect(d.getDispatchContextById(first.id)).toMatchObject({
      status: 'completed',
      completed_at: expect.any(String),
      capability_revoked_at: expect.any(String),
      failure_count: 0
    })
    expect(d.getDispatchContextById('ctx-gate-dispatched')).toMatchObject({
      status: 'completed',
      completed_at: expect.any(String),
      capability_revoked_at: expect.any(String),
      failure_count: 0
    })
  })

  it('retires current start_unknown authority when blocked becomes ready', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'blocked to ready retirement' })
    const started = d.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    d.markWorkerStartUnknown(started.dispatch.id, 'agent_readiness', 'uncertain')

    d.updateTaskStatus(task.id, 'ready')

    expect(d.getDispatchContextById(started.dispatch.id)).toMatchObject({
      status: 'failed',
      failure_count: 0,
      capability_revoked_at: expect.any(String)
    })
    expect(d.getWorkerDispatch(started.dispatch.id)?.state).toBe('start_unknown')
  })

  it('retires every legacy active dispatch before replacement creation', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'legacy active replacement' })
    const first = d.createDispatchContext(task.id, 'term-legacy-a')
    const rawDb = (
      d as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): void } }
      }
    ).db
    rawDb.prepare('UPDATE tasks SET status = ? WHERE id = ?').run('ready', task.id)
    const replacement = d.createDispatchContext(task.id, 'term-legacy-b')

    expect(d.getDispatchContextById(first.id)).toMatchObject({
      status: 'failed',
      failure_count: 0,
      capability_revoked_at: expect.any(String)
    })
    expect(d.getDispatchContextById(replacement.id)).toMatchObject({ status: 'dispatched' })
  })

  it('retires uncertain gate residue on resolution', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'gate retirement' })
    const dispatch = d.createDispatchContext(task.id, 'term-gate')
    const gate = d.createGate({ taskId: task.id, question: 'Continue?' })

    expect(d.getTask(task.id)?.status).toBe('blocked')
    expect(d.getDispatchContextById(dispatch.id)).toMatchObject({ status: 'completed' })

    const rawDb = (
      d as unknown as {
        db: { prepare(sql: string): { run(...args: unknown[]): void } }
      }
    ).db
    rawDb
      .prepare("UPDATE dispatch_contexts SET status = 'dispatched' WHERE id = ?")
      .run(dispatch.id)
    d.resolveGate(gate.id, 'yes')

    expect(d.getGate(gate.id)).toMatchObject({ status: 'resolved', resolution: 'yes' })
    expect(d.getTask(task.id)?.status).toBe('ready')
    expect(d.getDispatchContextById(dispatch.id)).toMatchObject({
      status: 'failed',
      capability_revoked_at: expect.any(String)
    })
  })

  it('keeps a completed task terminal after public completion settles its dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'completed task' })
    const dispatch = d.createDispatchContext(task.id, 'term-completed')
    d.updateTaskStatus(task.id, 'completed', 'completed result')

    expect(d.failDispatchWithDisposition(dispatch.id, 'late failure')).toMatchObject({
      taskTransitionApplied: false,
      dispatch: { status: 'completed', failure_count: 0 }
    })
    expect(d.getTask(task.id)).toMatchObject({
      status: 'completed',
      result: 'completed result',
      completed_at: expect.any(String)
    })
  })

  it('retires the dispatch when its task becomes failed', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'failed task' })
    const dispatch = d.createDispatchContext(task.id, 'term-failed')
    d.updateTaskStatus(task.id, 'failed', 'failed result')

    expect(d.failDispatchWithDisposition(dispatch.id, 'late failure')).toMatchObject({
      taskTransitionApplied: false,
      dispatch: { status: 'failed' }
    })
    expect(d.getTask(task.id)).toMatchObject({
      status: 'failed',
      result: 'failed result',
      completed_at: expect.any(String)
    })
  })

  it('completed dispatch is idempotent', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'idempotent failure' })
    const dispatch = d.createDispatchContext(task.id, 'term-idempotent')
    d.completeDispatch(dispatch.id)

    expect(d.failDispatchWithDisposition(dispatch.id, 'duplicate failure')).toMatchObject({
      taskTransitionApplied: false,
      dispatch: { status: 'completed', failure_count: 0 }
    })
    expect(d.failDispatchWithDisposition('missing-dispatch', 'unknown failure')).toEqual({
      taskTransitionApplied: false
    })
  })

  it('failed dispatch is idempotent', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'failed idempotence' })
    const dispatch = d.createDispatchContext(task.id, 'term-failed-idempotence')
    d.failDispatch(dispatch.id, 'first failure')

    expect(d.failDispatchWithDisposition(dispatch.id, 'duplicate failure')).toMatchObject({
      taskTransitionApplied: false,
      dispatch: { status: 'failed', failure_count: 1 }
    })
  })

  it('circuit-broken dispatch is idempotent', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'circuit idempotence' })
    for (let failure = 1; failure <= 3; failure += 1) {
      const dispatch = d.createDispatchContext(task.id, `term-circuit-${failure}`)
      d.failDispatch(dispatch.id, `failure ${failure}`)
    }
    const circuitBroken = d.getDispatchContext(task.id)

    expect(circuitBroken).toMatchObject({ status: 'circuit_broken', failure_count: 3 })
    expect(d.failDispatchWithDisposition(circuitBroken!.id, 'duplicate failure')).toMatchObject({
      taskTransitionApplied: false,
      dispatch: { status: 'circuit_broken', failure_count: 3 }
    })
  })
})
