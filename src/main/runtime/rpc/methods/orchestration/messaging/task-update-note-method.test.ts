import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { readWorkerDock } from '../../../../orchestration/dock/worker-dock-read'
import { isOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'

const CREATOR_SESSION = '11111111-1111-4111-8111-111111111111'
const CREATOR_PARTY = `orca_session_id:${CREATOR_SESSION}`
const WORKER_HANDLE = 'term_worker'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_WORKER_HANDLE = 'term_other'
const OTHER_WORKER_PANE = 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('orchestration.taskUpdate passive --note and self-dispatch invariants', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => {
    vi.restoreAllMocks()
    harness.cleanup()
  })

  function startSupervisedWorker(
    state: ReturnType<typeof harness.setup>,
    handle = WORKER_HANDLE,
    paneKey = WORKER_PANE,
    spec = 'Implement passive task notes'
  ) {
    if (!isOrcaSessionId(CREATOR_SESSION)) {
      throw new Error('Expected valid creator session UUID')
    }
    const task = state.db.createTask({ spec })
    const { dispatch } = state.db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: CREATOR_SESSION },
      maxDepth: 10,
      taskId: task.id,
      startOptions: { agent: 'codex' }
    })
    state.db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle,
      paneKey,
      processIncarnation: `runtime_test:${handle}:1`,
      worktreeId: 'repo_1::/tmp/wt',
      effects: [],
      setupState: 'not_applicable'
    })
    state.db.markWorkerDispatchReady(dispatch.id)
    return { task, dispatch }
  }

  it('records passive worker notes on dispatch_contexts without inserting mail or waking, while send --type status still wakes', async () => {
    const state = harness.setup()
    const { db, runtime, ctx, activeRunId } = state
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === WORKER_HANDLE
          ? WORKER_PANE
          : null
    )
    const wakes: { to: string; type: string | undefined }[] = []
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation((to, type) => {
      wakes.push({ to, type })
    })

    const { task, dispatch } = startSupervisedWorker(state)

    const receipt = await harness.call(
      'orchestration.taskUpdate',
      { callerTerminalHandle: WORKER_HANDLE, note: '  round 2 running on PR #49416  ' },
      ctx
    )
    expect(receipt).toMatchObject({
      task: { id: task.id, status: 'dispatched' },
      dispatchId: dispatch.id,
      progressNote: 'round 2 running on PR #49416'
    })

    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(wakes).toEqual([])

    await expect(
      harness.call('orchestration.workerShow', { dispatch: dispatch.id }, ctx)
    ).resolves.toMatchObject({
      dispatch: {
        progressNote: 'round 2 running on PR #49416',
        progressUpdatedAt: expect.any(String)
      }
    })
    await expect(
      harness.call('orchestration.sessionWorkers', { session: CREATOR_SESSION }, ctx)
    ).resolves.toMatchObject({
      workers: [{ dispatchId: dispatch.id, progressNote: 'round 2 running on PR #49416' }]
    })
    expect(readWorkerDock(db, { party: CREATOR_PARTY, direction: 'around' }).rows).toMatchObject([
      { dispatchId: dispatch.id, progressNote: 'round 2 running on PR #49416' }
    ])

    await harness.call(
      'orchestration.send',
      {
        from: WORKER_HANDLE,
        to: `run:${activeRunId}`,
        type: 'status',
        subject: 'PR #49416 ready',
        body: 'All required checks passed.'
      },
      ctx
    )
    expect(wakes).toEqual([{ to: `run:${activeRunId}`, type: 'status' }])
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
  })

  it('allows a coordinator to complete a task it dispatched to itself, refuses coordinator --note, and enforces worker ownership and bounds', async () => {
    const state = harness.setup()
    const { db, runtime, ctx } = state
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      if (handle === 'term_coord') {
        return harness.coordinatorPaneKey
      }
      if (handle === WORKER_HANDLE) {
        return WORKER_PANE
      }
      if (handle === OTHER_WORKER_HANDLE) {
        return OTHER_WORKER_PANE
      }
      return null
    })
    vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})

    // Self-dispatched coordinator task can still be completed via task-update --id T --status completed.
    const selfTask = db.createTask({ spec: 'Coordinator self-dispatched work' })
    await harness.call(
      'orchestration.dispatch',
      { task: selfTask.id, to: 'term_coord', from: 'term_coord' },
      ctx
    )
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { id: selfTask.id, status: 'completed', callerTerminalHandle: 'term_coord' },
        ctx
      )
    ).resolves.toMatchObject({
      task: { id: selfTask.id, status: 'completed' }
    })

    const first = startSupervisedWorker(state, WORKER_HANDLE, WORKER_PANE, 'Task A')
    const second = startSupervisedWorker(state, OTHER_WORKER_HANDLE, OTHER_WORKER_PANE, 'Task B')

    // Coordinator --note is refused even with --id naming an active worker task.
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { id: first.task.id, note: 'coordinator note', callerTerminalHandle: 'term_coord' },
        ctx
      )
    ).rejects.toMatchObject({ code: 'forbidden' })

    // Worker A cannot set --note on Worker B's task.
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { id: second.task.id, note: 'wrong target', callerTerminalHandle: WORKER_HANDLE },
        ctx
      )
    ).rejects.toMatchObject({ code: 'sender_not_assignee' })

    // Zod rejects >500 chars and status+note combinations.
    expect(() =>
      harness.findMethod('orchestration.taskUpdate').params?.parse({
        callerTerminalHandle: WORKER_HANDLE,
        note: 'x'.repeat(501)
      })
    ).toThrow(/at most 500 characters/)
    expect(() =>
      harness.findMethod('orchestration.taskUpdate').params?.parse({
        id: first.task.id,
        status: 'dispatched',
        note: 'combined'
      })
    ).toThrow(/cannot be combined with --status/)

    // Settled worker cannot record passive notes after worker_done.
    await harness.call(
      'orchestration.send',
      {
        from: WORKER_HANDLE,
        type: 'worker_done',
        subject: 'Done',
        body: 'Finished task A.',
        payload: JSON.stringify({
          taskId: first.task.id,
          dispatchId: first.dispatch.id,
          outcome: 'succeeded'
        })
      },
      ctx
    )
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { callerTerminalHandle: WORKER_HANDLE, note: 'late note' },
        ctx
      )
    ).rejects.toMatchObject({ code: 'dispatch_inactive' })
    expect(db.getDispatchContextById(second.dispatch.id)?.progress_note).toBeNull()
  })
})
