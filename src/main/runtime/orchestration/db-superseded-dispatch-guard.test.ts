import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

// #11499: failDispatch used to move the TASK unconditionally, so a superseded
// dispatch's terminal exiting reopened work another dispatch already completed.
// These tests pin the guard: only the task's current dispatch, while the task
// is still on an active attempt, may transition the task.
describe('failDispatch superseded-dispatch guard', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  // Supersede A → dispatch B → B completes → A's terminal exits.
  it('does not reopen a completed task when a superseded dispatch fails', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'supersede-sensitive work' })
    const superseded = d.createDispatchContext(task.id, 'term_a')
    d.updateTaskStatus(task.id, 'ready')
    const current = d.createDispatchContext(task.id, 'term_b')
    const settlement = d.settleWorkerReport({
      taskId: task.id,
      dispatchId: current.id,
      outcome: 'succeeded',
      result: 'done by B'
    })
    expect(settlement.action).toBe('settled')
    expect(d.getTask(task.id)?.status).toBe('completed')

    const failed = d.failDispatch(superseded.id, 'Agent exited with code 0')

    expect(failed?.status).toBe('failed')
    expect(d.getTask(task.id)?.status).toBe('completed')
    expect(d.getDispatchContextById(current.id)?.status).toBe('completed')
  })

  it('leaves a concurrently re-dispatched task untouched when the superseded dispatch fails', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'supersede window' })
    const superseded = d.createDispatchContext(task.id, 'term_a')
    d.updateTaskStatus(task.id, 'ready')
    const current = d.createDispatchContext(task.id, 'term_b')

    const failed = d.failDispatch(superseded.id, 'Agent exited with code 0')

    expect(failed?.status).toBe('failed')
    expect(d.getTask(task.id)?.status).toBe('dispatched')
    expect(d.getDispatchContextById(current.id)?.status).toBe('dispatched')
  })

  it('leaves an already-settled dispatch and its task untouched', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'settled work' })
    const ctx = d.createDispatchContext(task.id, 'term_a')
    const settlement = d.settleWorkerReport({
      taskId: task.id,
      dispatchId: ctx.id,
      outcome: 'succeeded',
      result: 'done'
    })
    expect(settlement.action).toBe('settled')

    const result = d.failDispatch(ctx.id, 'Agent exited with code 0')

    expect(result?.status).toBe('completed')
    expect(result?.failure_count).toBe(0)
    expect(d.getTask(task.id)?.status).toBe('completed')
  })

  it('still reopens the task when its current dispatch fails', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'normal crash' })
    const ctx = d.createDispatchContext(task.id, 'term_a')

    const failed = d.failDispatch(ctx.id, 'Agent exited with code -1')

    expect(failed?.status).toBe('failed')
    expect(d.getTask(task.id)?.status).toBe('ready')
  })

  it('still fails the task when the circuit breaker trips on the current dispatch', () => {
    const d = createDb()
    const task = d.createTask({ spec: 'flaky' })
    let ctx = d.createDispatchContext(task.id, 'term_a')
    d.failDispatch(ctx.id, 'timeout')
    ctx = d.createDispatchContext(task.id, 'term_a')
    d.failDispatch(ctx.id, 'timeout')
    ctx = d.createDispatchContext(task.id, 'term_a')

    const after3 = d.failDispatch(ctx.id, 'timeout')

    expect(after3?.status).toBe('circuit_broken')
    expect(d.getTask(task.id)?.status).toBe('failed')
  })
})
