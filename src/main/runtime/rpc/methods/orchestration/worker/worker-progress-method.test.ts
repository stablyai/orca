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

describe('orchestration.progress passive worker status', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  function startSupervisedWorker(
    state: ReturnType<typeof harness.setup>,
    handle = WORKER_HANDLE,
    paneKey = WORKER_PANE,
    spec = 'Implement passive progress'
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

  it('updates workerShow, sessionWorkers, and workerDock without inserting mail or waking recipients, while send --type status still wakes', async () => {
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

    const firstReceipt = await harness.call(
      'orchestration.progress',
      { from: WORKER_HANDLE, note: '  round 1 checks green  ' },
      ctx
    )
    expect(firstReceipt).toMatchObject({
      dispatchId: dispatch.id,
      taskId: task.id,
      runId: activeRunId,
      note: 'round 1 checks green'
    })

    const replacedReceipt = await harness.call(
      'orchestration.progress',
      { from: WORKER_HANDLE, dispatchId: dispatch.id, note: 'round 2 running on PR #42' },
      ctx
    )
    expect(replacedReceipt).toMatchObject({
      dispatchId: dispatch.id,
      note: 'round 2 running on PR #42'
    })

    // Passive progress never writes coordinator mail and never triggers notifyMessageArrived.
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 0 })
    expect(wakes).toEqual([])

    const shown = await harness.call('orchestration.workerShow', { dispatch: dispatch.id }, ctx)
    expect(shown).toMatchObject({
      dispatch: {
        progressNote: 'round 2 running on PR #42',
        progressUpdatedAt: expect.any(String)
      }
    })

    const sessionWorkers = await harness.call(
      'orchestration.sessionWorkers',
      { session: CREATOR_SESSION },
      ctx
    )
    expect(sessionWorkers).toMatchObject({
      workers: [{ dispatchId: dispatch.id, progressNote: 'round 2 running on PR #42' }]
    })

    const dockWhileRunning = readWorkerDock(db, { party: CREATOR_PARTY, direction: 'around' })
    expect(dockWhileRunning.rows).toMatchObject([
      { dispatchId: dispatch.id, progressNote: 'round 2 running on PR #42' }
    ])

    // Existing send --type status keeps its wake behavior unchanged for genuine one-way alerts.
    await harness.call(
      'orchestration.send',
      {
        from: WORKER_HANDLE,
        to: `run:${activeRunId}`,
        type: 'status',
        subject: 'PR #42 ready for merge',
        body: 'All required checks passed.'
      },
      ctx
    )
    expect(wakes).toEqual([{ to: `run:${activeRunId}`, type: 'status' }])
    expect(db.db.prepare('SELECT COUNT(*) AS count FROM messages').get()).toEqual({ count: 1 })
  })

  it('enforces the 500-character bound and rejects empty notes without mutating dispatch state', async () => {
    const state = harness.setup()
    const { db, runtime, ctx } = state
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
      handle === 'term_coord'
        ? harness.coordinatorPaneKey
        : handle === WORKER_HANDLE
          ? WORKER_PANE
          : null
    )
    const { dispatch } = startSupervisedWorker(state)

    const maxNote = 'x'.repeat(500)
    await expect(
      harness.call('orchestration.progress', { from: WORKER_HANDLE, note: maxNote }, ctx)
    ).resolves.toMatchObject({
      dispatchId: dispatch.id,
      note: maxNote
    })

    expect(() =>
      harness.findMethod('orchestration.progress').params?.parse({
        from: WORKER_HANDLE,
        note: 'x'.repeat(501)
      })
    ).toThrow(/at most 500 characters/)

    expect(() =>
      harness.findMethod('orchestration.progress').params?.parse({
        from: WORKER_HANDLE,
        note: '   '
      })
    ).toThrow(/Missing --note/)

    expect(db.getDispatchContextById(dispatch.id)?.progress_note).toBe(maxNote)
  })

  it('rejects callers outside an active worker Dispatch and cross-worker dispatchId claims', async () => {
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

    // Coordinator has no active worker Dispatch and gets clear guidance distinguishing send.
    await expect(
      harness.call('orchestration.progress', { from: 'term_coord', note: 'coordinating' }, ctx)
    ).rejects.toMatchObject({
      code: 'dispatch_inactive',
      message: expect.stringContaining('orca orchestration send')
    })

    // Worker A cannot write progress onto Worker B's active Dispatch.
    await expect(
      harness.call(
        'orchestration.progress',
        { from: WORKER_HANDLE, dispatchId: second.dispatch.id, note: 'wrong target' },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'sender_not_assignee'
    })

    // Settled worker cannot record passive progress after worker_done.
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
      harness.call('orchestration.progress', { from: WORKER_HANDLE, note: 'late note' }, ctx)
    ).rejects.toMatchObject({
      code: 'dispatch_inactive'
    })
    expect(db.getDispatchContextById(second.dispatch.id)?.progress_note).toBeNull()
  })

  it('keeps send wake-only and documents passive progress in worker and bot preambles', () => {
    const workerPreamble = buildDispatchPreamble({
      taskId: 'task_1',
      dispatchId: 'ctx_1',
      taskSpec: 'Ship feature',
      coordinatorHandle: 'orca_session_id:c2dfa8cd-83ba-4e20-82f9-373cb960ae39',
      workerHandle: 'orca_session_id:02526aea-9198-4034-9fad-99aae5dab8ec'
    })
    expect(workerPreamble).toContain('`orca orchestration send` always wakes its recipient')
    expect(workerPreamble).toContain(
      'orca orchestration progress --from orca_session_id:02526aea-9198-4034-9fad-99aae5dab8ec --note "<concise live status>"'
    )

    const botPreamble = buildBotPreamble({
      name: 'CoordinatorBot',
      agent: 'codex',
      soul: null,
      memory: null
    })
    expect(botPreamble).toContain('orchestration send` always wakes the recipient')
    expect(botPreamble).toContain('Never send routine progress updates')
  })
})
