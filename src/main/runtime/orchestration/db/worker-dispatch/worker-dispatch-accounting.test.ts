import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { exposeDispatchContext } from '../../../rpc/methods/orchestration/worker/worker-observation'

// Residual N: per-dispatch accounting. dispatched_at must name the pending->dispatched
// edge (not the moment the row was created, which is a "starting" worker with no
// dispatch yet), a process exit code must be attributable to the dispatch id, and
// worker-show must expose enough to compute wallclock without a caller-side heuristic.
describe('per-dispatch accounting (residual N)', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  function startPendingWorker(d: OrchestrationDb) {
    const task = d.createTask({ runId: 'run_legacy_local', spec: 'accounting task' })
    const started = d.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: { topology: 'current' }
    })
    return { task, started }
  }

  it('does not stamp dispatched_at before the worker is actually dispatched', () => {
    const d = createDb()
    const { started } = startPendingWorker(d)

    // Why: the row was just created 'pending' with a 'starting' worker. Nothing has been
    // dispatched yet, so a non-null dispatched_at here would be a heuristic (created_at
    // masquerading as dispatched_at), not an observed fact.
    const dispatch = d.getDispatchContextById(started.dispatch.id)
    expect(dispatch?.dispatched_at).toBeNull()
  })

  it('stamps dispatched_at on the pending->dispatched edge', () => {
    const d = createDb()
    const { started } = startPendingWorker(d)
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    const dispatch = d.getDispatchContextById(started.dispatch.id)
    expect(dispatch?.status).toBe('dispatched')
    expect(dispatch?.dispatched_at).not.toBeNull()
  })

  it('records the observed exit code on failDispatch, attributable to the dispatch id', () => {
    const d = createDb()
    const { started } = startPendingWorker(d)
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)

    d.failDispatch(started.dispatch.id, 'process exited', {
      workerProcessExited: true,
      terminationReason: 'exited',
      exitCode: 7
    })

    const dispatch = d.getDispatchContextById(started.dispatch.id)
    expect(dispatch?.exit_code).toBe(7)
  })

  it('exposes dispatchedAt, completedAt, wallclockMs and exitCode on worker-show', () => {
    const d = createDb()
    const { started } = startPendingWorker(d)
    d.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_worker',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime:pty:1',
      worktreeId: 'repo::worktree',
      setupState: 'not_applicable',
      effects: []
    })
    d.markWorkerDispatchReady(started.dispatch.id)
    d.failDispatch(started.dispatch.id, 'process exited', {
      workerProcessExited: true,
      terminationReason: 'exited',
      exitCode: 1
    })

    const dispatch = d.getDispatchContextById(started.dispatch.id)
    const exposed = exposeDispatchContext(dispatch!)
    expect(exposed.exitCode).toBe(1)
    expect(exposed.terminationReason).toBe('exited')
    expect(typeof exposed.wallclockMs).toBe('number')
    expect(exposed.wallclockMs).toBeGreaterThanOrEqual(0)
  })

  it('reports wallclockMs null when dispatched_at or completed_at is missing, never a guess', () => {
    const d = createDb()
    const { started } = startPendingWorker(d)
    const dispatch = d.getDispatchContextById(started.dispatch.id)
    const exposed = exposeDispatchContext(dispatch!)
    expect(exposed.wallclockMs).toBeNull()
  })
})
