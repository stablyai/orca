import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { readWorkerDock } from '../../../../orchestration/dock/worker-dock-read'
import { isOrcaSessionId } from '../../../../../../shared/agent-session/identity/orca-session-address'
import { buildBotPreamble } from '../../../../../bots/bot-preamble'
import { buildDispatchPreamble } from '../../../../orchestration/workers/launch/worker-dispatch-preamble'

const CREATOR_SESSION = '11111111-1111-4111-8111-111111111111'
const CREATOR_PARTY = `orca_session_id:${CREATOR_SESSION}`
const WORKER_HANDLE = 'term_worker'
const WORKER_PANE = 'tab_worker:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OTHER_WORKER_HANDLE = 'term_other'
const OTHER_WORKER_PANE = 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'

describe('orchestration.taskUpdate passive --note and ownership contract', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  function startSupervisedWorker(
    state: ReturnType<typeof harness.setup>,
    handle = WORKER_HANDLE,
    paneKey = WORKER_PANE,
    spec = '# Implement passive task notes\n\nDetails that stay out of the dock title.'
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

  it('records passive worker notes on its own active task without changing status, mailing, or waking, while send --type status still wakes', async () => {
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
    // Simulate a legacy/raw task with null task_title so worker-dock title normalization is exercised too.
    db.db.prepare('UPDATE tasks SET task_title = NULL WHERE id = ?').run(task.id)

    expect(() => harness.findMethod('orchestration.progress')).toThrow(/Method not found/)

    const firstReceipt = await harness.call(
      'orchestration.taskUpdate',
      { callerTerminalHandle: WORKER_HANDLE, note: '  round 1 checks green  ' },
      ctx
    )
    expect(firstReceipt).toMatchObject({
      task: { id: task.id, status: 'dispatched', progress_note: 'round 1 checks green' },
      dispatchId: dispatch.id,
      progressNote: 'round 1 checks green'
    })

    // Worker can also combine --note with explicit own --id and matching --status dispatched without changing status.
    const replacedReceipt = await harness.call(
      'orchestration.taskUpdate',
      {
        id: task.id,
        status: 'dispatched',
        callerTerminalHandle: WORKER_HANDLE,
        note: 'round 2 running on PR #49416'
      },
      ctx
    )
    expect(replacedReceipt).toMatchObject({
      task: { id: task.id, status: 'dispatched', progress_note: 'round 2 running on PR #49416' },
      dispatchId: dispatch.id,
      progressNote: 'round 2 running on PR #49416'
    })

    // Passive task-update --note never inserts coordinator mail and never triggers notifyMessageArrived.
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(wakes).toEqual([])

    const shown = await harness.call('orchestration.workerShow', { dispatch: dispatch.id }, ctx)
    expect(shown).toMatchObject({
      dispatch: {
        progressNote: 'round 2 running on PR #49416',
        progressUpdatedAt: expect.any(String)
      }
    })

    const sessionWorkers = await harness.call(
      'orchestration.sessionWorkers',
      { session: CREATOR_SESSION },
      ctx
    )
    expect(sessionWorkers).toMatchObject({
      workers: [{ dispatchId: dispatch.id, progressNote: 'round 2 running on PR #49416' }]
    })

    const listed = await harness.call('orchestration.taskList', {}, ctx)
    expect(listed).toMatchObject({
      tasks: [{ id: task.id, status: 'dispatched', progress_note: 'round 2 running on PR #49416' }]
    })

    const dockWhileRunning = readWorkerDock(db, { party: CREATOR_PARTY, direction: 'around' })
    expect(dockWhileRunning.rows).toMatchObject([
      {
        dispatchId: dispatch.id,
        title: 'Implement passive task notes',
        progressNote: 'round 2 running on PR #49416'
      }
    ])

    // Coordinator can combine --status and --note on an unstarted task in its Run without waking anyone.
    const pendingTask = db.createTask({ spec: 'Follow-up cleanup' })
    const coordCombined = await harness.call(
      'orchestration.taskUpdate',
      {
        id: pendingTask.id,
        status: 'blocked',
        note: 'waiting on upstream release',
        callerTerminalHandle: 'term_coord'
      },
      ctx
    )
    expect(coordCombined).toMatchObject({
      task: {
        id: pendingTask.id,
        status: 'blocked',
        progress_note: 'waiting on upstream release'
      },
      progressNote: 'waiting on upstream release'
    })
    expect(wakes).toEqual([])
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })

    // Existing send --type status keeps its wake behavior unchanged for genuine one-way alerts.
    await harness.call(
      'orchestration.send',
      {
        from: WORKER_HANDLE,
        to: `run:${activeRunId}`,
        type: 'status',
        subject: 'PR #49416 ready for merge',
        body: 'All required checks passed.'
      },
      ctx
    )
    expect(wakes).toEqual([{ to: `run:${activeRunId}`, type: 'status' }])
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
  })

  it('enforces the 500-character bound and rolls back atomic --status + --note refusals', async () => {
    const state = harness.setup()
    const { db, runtime, ctx } = state
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === WORKER_HANDLE
          ? WORKER_PANE
          : null
    )
    const { task, dispatch } = startSupervisedWorker(state)

    const maxNote = 'x'.repeat(500)
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { callerTerminalHandle: WORKER_HANDLE, note: maxNote },
        ctx
      )
    ).resolves.toMatchObject({
      dispatchId: dispatch.id,
      progressNote: maxNote
    })

    expect(() =>
      harness.findMethod('orchestration.taskUpdate').params?.parse({
        callerTerminalHandle: WORKER_HANDLE,
        note: 'x'.repeat(501)
      })
    ).toThrow(/at most 500 characters/)

    expect(() =>
      harness.findMethod('orchestration.taskUpdate').params?.parse({
        callerTerminalHandle: WORKER_HANDLE,
        note: '   '
      })
    ).toThrow(/--note cannot be empty/)

    expect(() =>
      harness.findMethod('orchestration.taskUpdate').params?.parse({
        id: task.id
      })
    ).toThrow(/Choose --status, --note, or both/)

    // A worker trying to settle its own task via --status completed + --note is refused atomically without overwriting progress_note.
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { callerTerminalHandle: WORKER_HANDLE, status: 'completed', note: 'must not persist' },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'task_not_startable'
    })

    expect(db.getDispatchContextById(dispatch.id)?.progress_note).toBe(maxNote)
    expect(db.getTask(task.id)?.status).toBe('dispatched')
  })

  it('refuses workers targeting unowned task --id, inactive dispatches, and legacy remote attachments', async () => {
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

    const first = startSupervisedWorker(state, WORKER_HANDLE, WORKER_PANE, 'Task A')
    const second = startSupervisedWorker(state, OTHER_WORKER_HANDLE, OTHER_WORKER_PANE, 'Task B')

    // Coordinator without an active worker Dispatch must supply --id.
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { callerTerminalHandle: 'term_coord', note: 'coordinating' },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'dispatch_inactive',
      message: expect.stringContaining('pass --id <task_id>')
    })

    // A coordinator holding a self-created Dispatch in its Run retains task-update access to sibling tasks.
    const selfTask = db.createTask({ spec: 'Coordinator self task' })
    await harness.call(
      'orchestration.dispatch',
      { task: selfTask.id, to: 'term_coord', from: 'term_coord' },
      ctx
    )
    const siblingTask = db.createTask({ spec: 'Sibling task in same Run' })
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { id: siblingTask.id, status: 'ready', callerTerminalHandle: 'term_coord' },
        ctx
      )
    ).resolves.toMatchObject({
      task: { id: siblingTask.id, status: 'ready' }
    })

    // Worker A cannot target Worker B's task via --id.
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        {
          id: second.task.id,
          callerTerminalHandle: WORKER_HANDLE,
          note: 'wrong task target'
        },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'sender_not_assignee',
      message: expect.stringContaining(`owns active task ${first.task.id}, not ${second.task.id}`)
    })

    // Settled worker cannot record passive notes after worker_done, nor target another task.
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
    ).rejects.toMatchObject({
      code: 'dispatch_inactive'
    })
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { id: second.task.id, callerTerminalHandle: WORKER_HANDLE, note: 'other task after done' },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'sender_not_assignee'
    })

    // Legacy remote-attached panes reject instead of returning an unstored receipt.
    db.db
      .prepare(
        `INSERT INTO remote_dispatch_attachments (
          dispatch_id, task_id, home_peer_fingerprint, runtime_epoch, home_run_id,
          pane_key, terminal_handle, process_incarnation, state, stage
        ) VALUES (?, ?, 'peer_fp_1', 'epoch_1', 'run_home_1', ?, ?, ?, 'ready', 'ready')`
      )
      .run(
        'ctx_remote_1',
        'task_remote_1',
        OTHER_WORKER_PANE,
        OTHER_WORKER_HANDLE,
        `runtime_test:${OTHER_WORKER_HANDLE}:1`
      )
    await expect(
      harness.call(
        'orchestration.taskUpdate',
        { callerTerminalHandle: OTHER_WORKER_HANDLE, note: 'remote note' },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'unsupported_remote_dispatch'
    })
    expect(db.getDispatchContextById(second.dispatch.id)?.progress_note).toBeNull()
  })

  it('states the send vs task-update --note wake rule in worker and bot preambles', () => {
    const workerPreamble = buildDispatchPreamble({
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      taskSpec: 'Ship feature',
      coordinatorHandle: 'orca_session_id:c2dfa8cd-83ba-4e20-82f9-373cb960ae39',
      workerHandle: 'orca_session_id:02526aea-9198-4034-9fad-99aae5dab8ec'
    })
    expect(workerPreamble).toContain(
      'send = always wakes the recipient; task-update --note = passive, never wakes.'
    )
    expect(workerPreamble).toContain(
      'orca orchestration task-update --from orca_session_id:02526aea-9198-4034-9fad-99aae5dab8ec --note "<concise live status>"'
    )
    expect(workerPreamble).not.toContain('orchestration progress')

    const botPreamble = buildBotPreamble({
      name: 'CoordinatorBot',
      agent: 'codex',
      soul: null,
      memory: null
    })
    expect(botPreamble).toContain('`task-update --note` = passive, never wakes')
    expect(botPreamble).toContain('never send routine progress updates')
  })
})
