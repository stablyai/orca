import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'

const PANE_W = 'tab_w:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('a Task whose supervised worker is stopping', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function localWorker() {
    const task = db.createTask({ runId: 'run_legacy_local', spec: 'local work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: 'term_w',
      paneKey: PANE_W,
      processIncarnation: 'inc1',
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_configured'
    })
    db.markWorkerDispatchReady(dispatch.id)
    return { task, dispatch }
  }

  describe('task-update', () => {
    it('refuses to re-open the Task while the worker is stopping', () => {
      const { task, dispatch } = localWorker()
      db.beginWorkerStop(dispatch.id, 'epoch_home')
      expect(db.getTask(task.id)?.status).toBe('blocked')

      expect(() => db.updateTaskStatus(task.id, 'dispatched')).toThrowError(
        expect.objectContaining({
          code: 'task_not_startable',
          data: { taskId: task.id, dispatchId: dispatch.id }
        })
      )
      expect(db.getTask(task.id)?.status).toBe('blocked')
    })

    it('refuses to re-open the Task while the stop outcome is unknown', () => {
      const { task, dispatch } = localWorker()
      db.beginWorkerStop(dispatch.id, 'epoch_home')
      db.markWorkerStopUnknown(dispatch.id, 'the execution host did not answer')

      expect(() => db.updateTaskStatus(task.id, 'dispatched')).toThrowError(
        expect.objectContaining({ code: 'task_not_startable' })
      )
      expect(db.getTask(task.id)?.status).toBe('blocked')
    })

    it('control: still accepts dispatched for an active Dispatch with no supervised worker', () => {
      const task = db.createTask({ runId: 'run_legacy_local', spec: 'unsupervised work' })
      createRootDispatch(db, task.id, 'term_worker')

      expect(db.updateTaskStatus(task.id, 'dispatched')?.status).toBe('dispatched')
    })

    it('control: still accepts dispatched while the supervised worker is ready', () => {
      const { task } = localWorker()

      expect(db.updateTaskStatus(task.id, 'dispatched')?.status).toBe('dispatched')
    })

    it('control: a no-op re-assert of dispatched under a stopping worker stays legal', () => {
      const { task, dispatch } = localWorker()
      expect(db.getTask(task.id)?.status).toBe('dispatched')
      db.beginWorkerStop(dispatch.id, 'epoch_home')
      // Use SQL to restore dispatched without invoking the guarded reopen path.
      db.db.prepare("UPDATE tasks SET status = 'dispatched' WHERE id = ?").run(task.id)

      expect(db.updateTaskStatus(task.id, 'dispatched')?.status).toBe('dispatched')
    })
  })

  describe('operator escape', () => {
    it('accepts a re-issued worker-stop and reaches an honest stop_unknown outcome', () => {
      const { task, dispatch } = localWorker()
      db.beginWorkerStop(dispatch.id, 'epoch_dead_runtime')

      // A new runtime epoch must be able to reissue a stop abandoned by a crashed owner.
      const reissued = db.beginWorkerStop(dispatch.id, 'epoch_new_runtime')
      expect(reissued).toMatchObject({ disposition: 'stopping' })
      expect(db.getWorkerDispatch(dispatch.id)?.runtime_epoch).toBe('epoch_new_runtime')

      db.markWorkerStopUnknown(dispatch.id, 'the execution host did not answer')
      expect(db.abandonWorkerDispatch(dispatch.id, 'epoch_test')).toMatchObject({
        disposition: 'abandoned'
      })
      expect(db.getTask(task.id)?.status).toBe('blocked')
    })

    it('refuses a re-issue from the runtime whose own stop is still in flight', () => {
      const { dispatch } = localWorker()
      db.beginWorkerStop(dispatch.id, 'epoch_this_runtime')

      // A repeated stop must not overwrite stopping with unknown before the exit event lands.
      expect(() => db.beginWorkerStop(dispatch.id, 'epoch_this_runtime')).toThrowError(
        /cannot stop from stopping/
      )

      expect(db.getWorkerDispatch(dispatch.id)).toMatchObject({
        state: 'stopping',
        runtime_epoch: 'epoch_this_runtime'
      })
      expect(db.settleWorkerStop(dispatch.id).state).toBe('stopped')
      expect(db.getDispatchContextById(dispatch.id)).toMatchObject({
        status: 'failed',
        last_failure: 'stopped'
      })
    })
  })
})
