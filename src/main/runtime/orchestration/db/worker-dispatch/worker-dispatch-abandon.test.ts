import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'

const THIS_RUNTIME = 'epoch_this_runtime'

describe('worker-abandon settles a stuck worker', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })
  afterEach(() => db.close())

  function startWorker(taskId?: string, name = 'w') {
    const task = taskId
      ? db.getTask(taskId)!
      : db.createTask({ runId: 'run_legacy_local', spec: 'abandon work' })
    const { dispatch } = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      creator: { kind: 'system' },
      maxDepth: 9
    })
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle: `term_${name}`,
      paneKey: `tab_${name}:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${name.length}`,
      processIncarnation: `inc_${name}`,
      worktreeId: 'wt',
      effects: [],
      setupState: 'not_configured',
      terminalOwnership: 'created'
    })
    return { task, dispatch }
  }

  function readyWorker(taskId?: string, name?: string) {
    const started = startWorker(taskId, name)
    db.markWorkerDispatchReady(started.dispatch.id)
    return started
  }

  function setReleaseState(dispatchId: string, releaseState: string) {
    db.db
      .prepare('UPDATE worker_terminal_resources SET release_state = ? WHERE owner_dispatch_id = ?')
      .run(releaseState, dispatchId)
  }

  function storeArchive(dispatchId: string) {
    const resource = db.getWorkerTerminalResourceByOwner(dispatchId)!
    db.db
      .prepare(
        "INSERT INTO worker_terminal_archives (dispatch_id, resource_id, kind, content) VALUES (?, ?, 'terminal_tail', '{}')"
      )
      .run(dispatchId, resource.id)
  }

  function expectAbandoned(dispatchId: string, taskId: string, priorError?: string) {
    expect(db.getWorkerDispatch(dispatchId)).toMatchObject({
      state: 'abandoned',
      stage: 'abandoned',
      last_error: [priorError, 'Abandoned by term_coordinator.'].filter(Boolean).join(' ')
    })
    expect(db.getDispatchContextById(dispatchId)).toMatchObject({
      status: 'failed',
      last_failure: 'abandoned',
      capability_revoked_at: expect.any(String)
    })
    expect(db.getTask(taskId)?.status).toBe('blocked')
  }

  it('settles a stop another runtime left stranded in stopping', () => {
    const { task, dispatch } = readyWorker()
    db.beginWorkerStop(dispatch.id, 'epoch_dead_runtime')

    expect(db.abandonWorkerDispatch(dispatch.id, THIS_RUNTIME, 'term_coordinator')).toMatchObject({
      disposition: 'abandoned'
    })
    expectAbandoned(dispatch.id, task.id)
  })

  it.each([
    [
      'stop_unknown',
      'the terminal is external',
      (id: string) => {
        db.beginWorkerStop(id, THIS_RUNTIME)
        db.markWorkerStopUnknown(id, 'the terminal is external')
      }
    ],
    [
      'start_unknown',
      'lost contact',
      (id: string) => db.markWorkerStartUnknown(id, 'prompt', 'lost contact')
    ]
  ] as const)('settles a %s worker and records who abandoned it', (state, priorError, reach) => {
    const { task, dispatch } = startWorker()
    if (state === 'stop_unknown') {
      db.markWorkerDispatchReady(dispatch.id)
    }
    reach(dispatch.id)

    expect(db.abandonWorkerDispatch(dispatch.id, THIS_RUNTIME, 'term_coordinator')).toMatchObject({
      disposition: 'abandoned'
    })
    expectAbandoned(dispatch.id, task.id, priorError)
  })

  it('says so when it cannot tell who abandoned the worker', () => {
    const { dispatch } = readyWorker()
    db.abandonWorkerDispatch(dispatch.id, THIS_RUNTIME)

    expect(db.getWorkerDispatch(dispatch.id)?.last_error).toBe(
      'Abandoned by an unidentified caller.'
    )
  })

  it('settles an active attempt that is no longer the Task latest without touching the newer one', () => {
    const first = readyWorker(undefined, 'first')
    // An interleaved re-dispatch leaves two active attempts; the older one used to be a no-op.
    db.db.prepare("UPDATE tasks SET status = 'ready' WHERE id = ?").run(first.task.id)
    const second = readyWorker(first.task.id, 'second')

    expect(db.abandonWorkerDispatch(first.dispatch.id, THIS_RUNTIME).disposition).toBe('abandoned')
    expect(db.getWorkerDispatch(first.dispatch.id)?.state).toBe('abandoned')
    expect(db.getWorkerDispatch(second.dispatch.id)?.state).toBe('ready')
    expect(db.getTask(first.task.id)?.status).toBe('dispatched')
  })

  it.each(['requested', 'not_requested'] as const)(
    'retains the terminal of a worker it settles whose release is %s',
    (releaseState) => {
      const { dispatch } = readyWorker()
      setReleaseState(dispatch.id, releaseState)
      storeArchive(dispatch.id)

      expect(db.abandonWorkerDispatch(dispatch.id, THIS_RUNTIME).disposition).toBe('abandoned')
      expect(db.getWorkerTerminalResourceByOwner(dispatch.id)).toMatchObject({
        ownership_state: 'owned',
        release_state: 'retained',
        retained_reason: 'user_requested'
      })
      expect(db.getWorkerTerminalArchive(dispatch.id)).toBeUndefined()
    }
  )

  it('leaves a settled worker and its terminal release untouched', () => {
    const { dispatch } = readyWorker()
    db.failDispatch(dispatch.id, 'operator closed the tab', { workerProcessExited: true })
    setReleaseState(dispatch.id, 'requested')

    expect(db.abandonWorkerDispatch(dispatch.id, THIS_RUNTIME).disposition).toBe('already_settled')
    expect(db.getWorkerTerminalResourceByOwner(dispatch.id)?.release_state).toBe('requested')
  })

  it('keeps a committed release and a terminal Orca does not own as they are', () => {
    const releasing = readyWorker(undefined, 'releasing')
    setReleaseState(releasing.dispatch.id, 'releasing')
    const unknown = readyWorker(undefined, 'unknown')
    setReleaseState(unknown.dispatch.id, 'unknown')
    storeArchive(unknown.dispatch.id)
    const external = readyWorker(undefined, 'external')
    db.db
      .prepare(
        "UPDATE worker_terminal_resources SET ownership_state = 'external', release_state = 'unknown' WHERE owner_dispatch_id = ?"
      )
      .run(external.dispatch.id)

    db.abandonWorkerDispatch(releasing.dispatch.id, THIS_RUNTIME)
    db.abandonWorkerDispatch(unknown.dispatch.id, THIS_RUNTIME)
    db.abandonWorkerDispatch(external.dispatch.id, THIS_RUNTIME)

    expect(db.getWorkerTerminalResourceByOwner(releasing.dispatch.id)?.release_state).toBe(
      'releasing'
    )
    expect(db.getWorkerTerminalResourceByOwner(unknown.dispatch.id)?.release_state).toBe('unknown')
    expect(db.getWorkerTerminalArchive(unknown.dispatch.id)).toBeDefined()
    expect(db.getWorkerTerminalResourceByOwner(external.dispatch.id)).toMatchObject({
      ownership_state: 'external',
      release_state: 'unknown'
    })
  })

  it('reports an abandon repeated on an abandoned worker as already abandoned', () => {
    const { dispatch } = readyWorker()
    db.abandonWorkerDispatch(dispatch.id, THIS_RUNTIME)

    expect(db.abandonWorkerDispatch(dispatch.id, THIS_RUNTIME).disposition).toBe(
      'already_abandoned'
    )
  })
})
