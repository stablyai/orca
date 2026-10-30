import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { reattachDispatchConsumer } from './db/root-dispatch-test-fixture'

const WORKER_PANE_KEY = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INCARNATION = 'runtime_test:term_worker:1'
let db: OrchestrationDb

function startWorker(spec: string): { taskId: string; dispatchId: string } {
  const task = db.createTask({ runId: 'run_legacy_local', spec })
  const started = db.createStartingWorkerDispatch({
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER,
    taskId: task.id,
    startOptions: {}
  })
  reattachDispatchConsumer(db, {
    dispatchId: started.dispatch.id,
    paneKey: WORKER_PANE_KEY,
    processIncarnation: INCARNATION
  })
  return { taskId: task.id, dispatchId: started.dispatch.id }
}

describe('worker start settled by an unobserved prompt', () => {
  afterEach(() => db?.close())

  it('lets the worker report correct the record', () => {
    db = new OrchestrationDb(':memory:')
    const { taskId, dispatchId } = startWorker('run to completion')

    db.failWorkerStart(dispatchId, 'dispatch_input', 'agent_prompt_stalled')

    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'agent_prompt_stalled'
    })

    expect(
      db.settleWorkerReport({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        result: 'done the work'
      })
    ).toEqual({ action: 'settled', outcome: 'succeeded', duplicate: false })
    expect(db.getTask(taskId)).toMatchObject({ status: 'completed', result: 'done the work' })
    expect(db.getDispatchContextById(dispatchId)?.status).toBe('completed')
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({ state: 'succeeded', stage: 'settled' })
  })

  it('stays settled when the start failed for any other cause', () => {
    db = new OrchestrationDb(':memory:')
    const { taskId, dispatchId } = startWorker('never became ready')

    db.failWorkerStart(dispatchId, 'agent_readiness', 'Agent did not become ready (idle).')

    expect(db.getDispatchContextById(dispatchId)?.capability_revoked_at).toEqual(expect.any(String))
    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result: 'done' })
    ).toMatchObject({ action: 'rejected', code: 'inactive_dispatch' })
    expect(db.getTask(taskId)?.status).toBe('failed')
  })

  it('lets a failure report replace the unobserved-prompt cause with the real one', () => {
    db = new OrchestrationDb(':memory:')
    const { taskId, dispatchId } = startWorker('reports its own failure')

    db.failWorkerStart(dispatchId, 'dispatch_input', 'agent_prompt_stalled')

    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'failed', result: 'build broke on X' })
    ).toEqual({ action: 'settled', outcome: 'failed', duplicate: false })
    expect(db.getTask(taskId)).toMatchObject({ status: 'failed', result: 'build broke on X' })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'build broke on X'
    })
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({ state: 'failed', stage: 'settled' })

    // The stalled cause is gone, so a repeat report has nothing left to correct.
    expect(
      db.settleWorkerReport({ taskId, dispatchId, outcome: 'failed', result: 'again' })
    ).toEqual({ action: 'settled', outcome: 'failed', duplicate: true })
    expect(db.getTask(taskId)?.result).toBe('build broke on X')
  })

  it('rolls back every prompt-stall correction when the worker transition fails', () => {
    db = new OrchestrationDb(':memory:')
    const { taskId, dispatchId } = startWorker('atomic correction')
    db.failWorkerStart(dispatchId, 'dispatch_input', 'agent_prompt_stalled')
    // The worker correction is the last of the three, so aborting it must undo the other two.
    db.db.exec(`
      CREATE TRIGGER reject_worker_prompt_stall_correction
      BEFORE UPDATE ON worker_dispatches
      WHEN NEW.state = 'succeeded'
      BEGIN SELECT RAISE(ABORT, 'forced prompt-stall correction failure'); END;
    `)

    expect(() =>
      db.settleWorkerReport({
        taskId,
        dispatchId,
        outcome: 'succeeded',
        result: 'uncommitted result'
      })
    ).toThrow('forced prompt-stall correction failure')
    expect(db.getTask(taskId)).toMatchObject({ status: 'failed', result: null })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'agent_prompt_stalled'
    })
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'failed',
      stage: 'dispatch_input'
    })
  })

  it('keeps the identity its authority attached when a stalled start fails', () => {
    db = new OrchestrationDb(':memory:')
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'stalled after authority' })
    const started = db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: WORKER_PANE_KEY,
      processIncarnation: INCARNATION,
      worktreeId: 'repo::worker',
      effects: [],
      setupState: 'not_applicable',
      terminalOwnership: 'created'
    })
    // The custody row can name another pane of the same PTY (#17741); it must not win.
    db.db
      .prepare('UPDATE worker_terminal_resources SET pane_key = ? WHERE owner_dispatch_id = ?')
      .run('tab_custody:cccccccc-cccc-4ccc-8ccc-cccccccccccc', started.dispatch.id)

    db.failWorkerStart(started.dispatch.id, 'dispatch_input', 'agent_prompt_stalled')

    expect(db.getDispatchContextById(started.dispatch.id)).toMatchObject({
      assignee_pane_key: WORKER_PANE_KEY,
      process_incarnation: INCARNATION
    })
  })
})
