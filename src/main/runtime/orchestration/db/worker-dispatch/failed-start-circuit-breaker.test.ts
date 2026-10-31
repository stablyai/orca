/** Failed worker starts must advance the circuit breaker instead of spawning indefinitely. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { reattachDispatchConsumer } from '../root-dispatch-test-fixture'

const BLOCKED = 'Agent startup blocked: codex-interactive-prompt'

describe('failed worker starts and the circuit breaker', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function start(taskId: string, retryOf?: string): string {
    return db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId,
      retryOf,
      startOptions: {}
    }).dispatch.id
  }

  function failedStarts(taskId: string, count: number, reason = BLOCKED): string[] {
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      const id = start(taskId, ids.at(-1))
      db.failWorkerStart(id, 'agent_readiness', reason)
      ids.push(id)
    }
    return ids
  }

  function newTask(): string {
    return db.createTask({ runId: 'run_legacy_local', spec: 'never starts' }).id
  }

  it('counts each failed start and carries the count into the retry', () => {
    const taskId = newTask()
    const [first, second] = failedStarts(taskId, 2)

    expect(db.getDispatchContextById(first)).toMatchObject({ status: 'failed', failure_count: 1 })
    expect(db.getDispatchContextById(second)).toMatchObject({ status: 'failed', failure_count: 2 })
    expect(db.getTask(taskId)?.status).toBe('failed')
  })

  it('trips on the third failed start and refuses a fourth retry', () => {
    const taskId = newTask()
    const [, , third] = failedStarts(taskId, 3)

    expect(db.getDispatchContextById(third)).toMatchObject({
      status: 'circuit_broken',
      failure_count: 3
    })
    expect(db.getWorkerDispatch(third)?.state).toBe('failed')
    expect(db.getTask(taskId)?.status).toBe('failed')

    let refusal: unknown
    try {
      start(taskId, third)
    } catch (error) {
      refusal = error
    }
    expect(refusal).toMatchObject({
      code: 'task_not_startable',
      message: `Task ${taskId} failed 3 times, so Orca will not retry it again (last error: ${BLOCKED}). Report the failure to the user instead of retrying.`,
      data: { taskId, status: 'failed', retryOf: third, failureCount: 3 }
    })
    expect(refusal).toMatchObject({
      data: { nextSteps: [expect.stringMatching(/^Do not retry this Task/), expect.any(String)] }
    })
    expect(db.getTask(taskId)?.status).toBe('failed')
  })

  it("does not count a worker's own failed report, only a start that never ran", () => {
    const taskId = newTask()
    const [failed] = failedStarts(taskId, 1)
    const ran = start(taskId, failed)
    reattachDispatchConsumer(db, {
      dispatchId: ran,
      paneKey: 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      processIncarnation: 'inc_worker'
    })
    db.settleWorkerReport({ taskId, dispatchId: ran, outcome: 'failed', result: 'tests red' })

    expect(db.getDispatchContextById(ran)).toMatchObject({ status: 'failed', failure_count: 1 })
    const retried = start(taskId, ran)
    expect(db.getDispatchContextById(retried)?.failure_count).toBe(1)
  })

  it('lets a stalled-prompt worker still correct its record after the breaker tripped', () => {
    const taskId = newTask()
    const [, , third] = failedStarts(taskId, 3, 'agent_prompt_stalled')
    expect(db.getDispatchContextById(third)?.status).toBe('circuit_broken')

    expect(
      db.settleWorkerReport({ taskId, dispatchId: third, outcome: 'succeeded', result: 'done' })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    expect(db.getDispatchContextById(third)?.status).toBe('completed')
    expect(db.getTask(taskId)).toMatchObject({ status: 'completed', result: 'done' })
  })

  it('keeps the breaker tripped when that worker reports its own failure', () => {
    const taskId = newTask()
    const [, , third] = failedStarts(taskId, 3, 'agent_prompt_stalled')

    expect(
      db.settleWorkerReport({ taskId, dispatchId: third, outcome: 'failed', result: 'broke on X' })
    ).toEqual({ action: 'settled', outcome: 'failed', duplicate: false })
    expect(db.getDispatchContextById(third)).toMatchObject({
      status: 'circuit_broken',
      last_failure: 'broke on X'
    })
    expect(
      db.settleWorkerReport({ taskId, dispatchId: third, outcome: 'failed', result: 'broke on X' })
    ).toEqual({ action: 'settled', outcome: 'failed', duplicate: true })
    expect(() => start(taskId, third)).toThrow(/will not retry it again/)
  })

  it('starts a fresh count after explicitly reopening a circuit-broken Task', () => {
    const taskId = newTask()
    const [, , third] = failedStarts(taskId, 3)
    expect(() => start(taskId, third)).toThrow(/will not retry it again/)
    db.updateTaskStatus(taskId, 'ready')
    expect(() => start(taskId, third)).toThrow(/will not retry it again/)

    expect(db.getDispatchContextById(start(taskId))).toMatchObject({
      task_id: taskId,
      failure_count: 0
    })
    expect(db.getDispatchContextById(third)).toMatchObject({
      status: 'circuit_broken',
      failure_count: 3
    })
  })
})
