import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { createRootDispatch } from '../root-dispatch-test-fixture'

// Residual M: a Dispatch created context-only (e.g. `orchestration dispatch --inject`) has no
// worker_dispatches row, so it must still be discoverable and settleable on recovery — never
// silently left live forever because it fell outside the supervised-worker recovery query.
describe('unsupervised dispatch recovery (residual M)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('surfaces an active context-only dispatch that has no worker_dispatches row', () => {
    const d = createDb()
    const run = d.createRun({
      objective: 'inject',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    const task = d.createTask({ runId: run.id, spec: 'injected work' })
    const injected = createRootDispatch(
      d,
      task.id,
      'term_injected',
      'tab_injected:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      undefined,
      'pty-injected:1'
    )

    expect(d.getWorkerDispatch(injected.id)).toBeUndefined()
    expect(d.listUnsupervisedActiveDispatches().map((row) => row.id)).toEqual([injected.id])
  })

  it('excludes a supervised worker dispatch (it has its own recovery path)', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'supervised' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })

    expect(d.listUnsupervisedActiveDispatches()).toEqual([])
    void started
  })

  it('excludes a settled context-only dispatch', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'settled' })
    const injected = createRootDispatch(d, task.id, 'term_settled')
    d.completeDispatch(injected.id)

    expect(d.listUnsupervisedActiveDispatches()).toEqual([])
  })

  it('fails an unsupervised dispatch with termination_reason unknown, without a worker row', () => {
    const d = createDb()
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'injected work' })
    const injected = createRootDispatch(d, task.id, 'term_injected')

    const result = d.reconcileMissingWorkerTerminal(
      injected.id,
      'Unsupervised dispatch terminal is no longer live after orchestration recovery.'
    )

    // Why null: there is no worker_dispatches row for this Dispatch, and this path must not
    // fabricate one.
    expect(result).toBeNull()
    expect(d.getWorkerDispatch(injected.id)).toBeUndefined()
    const settled = d.getDispatchContextById(injected.id)
    expect(settled).toMatchObject({
      status: 'failed',
      termination_reason: 'unknown',
      capability_revoked_at: expect.any(String)
    })
  })
})
