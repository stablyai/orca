import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { RpcContext } from '../../../core'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import type { OrchestrationSessionCaller } from '../../../../orchestration/orchestration-caller-identity'
import { testOrcaSessionId } from '../../../../../../shared/orca-session-address-test-fixture'

describe('a worker after its worker_done', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())
  const sessionCaller = (id: string): OrchestrationSessionCaller => ({
    address: 'term_worker',
    terminalHandle: 'term_worker',
    paneKey: 'tab_worker:leaf_worker',
    orcaSessionId: testOrcaSessionId(id),
    sessionId: testOrcaSessionId(id),
    workspaceId: 'wt'
  })

  it('still reaches its coordinator with every message, and none changes the finished Task', async () => {
    const { db, runtime, ctx, activeRunId } = harness.setup()
    const task = db.createTask({ spec: 'work' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      undefined,
      'runtime_test:term_worker:1'
    )
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker'
        ? 'tab_worker:leaf_worker'
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    const send = (params: Record<string, unknown>) =>
      harness.call('orchestration.send', { from: 'term_worker', ...params }, ctx)
    const report = (outcome: string) =>
      JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome })

    await send({ type: 'worker_done', subject: 'Done', payload: report('succeeded') })
    const settled = db.getTask(task.id)

    await send({ subject: 'No recipient' })
    await send({ to: `dispatch:${dispatch.id}`, subject: 'To my own Dispatch' })
    const again = await send({
      type: 'worker_done',
      subject: 'Second report',
      payload: report('failed')
    })
    // It has no turn for a later answer to wake, so even a returning ask waits for the answer.
    const asking = harness.call(
      'orchestration.ask',
      { from: 'term_worker', question: 'Anything else?', wait: false, timeoutMs: 5_000 },
      ctx
    )
    await vi.waitFor(() => expect(db.getUnreadMessages(`run:${activeRunId}`)).toHaveLength(5))
    const question = db.getUnreadMessages(`run:${activeRunId}`)[4]

    expect(again).toMatchObject({ lifecycle: { action: 'settled', outcome: 'succeeded' } })
    expect(db.getTask(task.id)).toEqual(settled)
    expect(db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
    expect(
      db.getUnreadMessages(`run:${activeRunId}`).map((message) => [message.type, message.subject])
    ).toEqual([
      ['worker_done', 'Done'],
      ['status', 'No recipient'],
      ['status', 'To my own Dispatch'],
      ['status', 'Second report'],
      ['question', 'Question']
    ])
    await harness.call(
      'orchestration.reply',
      { from: 'term_coord', id: question.id, body: 'Nothing else.' },
      ctx
    )
    expect(await asking).toMatchObject({ answer: 'Nothing else.', timedOut: false })
  })

  it("does not take a new process in the finished worker's pane for that worker", async () => {
    const { db, runtime, ctx } = harness.setup()
    const task = db.createTask({ spec: 'work' })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      'tab_worker:leaf_worker',
      undefined,
      'runtime_test:term_worker:1'
    )
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
    )
    await harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        type: 'worker_done',
        subject: 'Done',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
      },
      ctx
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:2')

    await expect(
      harness.call('orchestration.send', { from: 'term_worker', subject: 'Not mine' }, ctx)
    ).rejects.toMatchObject({ code: 'run_required' })
    // A chat in that pane is not the terminal worker either.
    await expect(
      harness.call(
        'orchestration.send',
        { from: 'term_worker', subject: 'Not mine either' },
        { ...ctx, orchestrationCaller: sessionCaller('chat_other') }
      )
    ).rejects.toMatchObject({ code: 'run_required' })
  })

  it('resumes its own question after a follow-up starts, but not as a later worker in the pane', async () => {
    const { db, runtime, ctx } = harness.setup()
    const task = db.createTask({ spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker'
        ? 'tab_worker:leaf_worker'
        : handle === 'term_coord'
          ? harness.coordinatorPaneKey
          : null
    )
    await harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        type: 'worker_done',
        subject: 'Done',
        payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
      },
      ctx
    )
    const asked = await harness.call(
      'orchestration.ask',
      { from: 'term_worker', question: 'Anything else?', timeoutMs: 1 },
      ctx
    )
    expect(asked).toMatchObject({ timedOut: true })
    const questionId =
      asked && typeof asked === 'object' && 'messageId' in asked ? asked.messageId : ''
    const later = createRootDispatch(
      db,
      db.createTask({ spec: 'more' }).id,
      'term_worker',
      'tab_worker:leaf_worker'
    )
    await harness.call(
      'orchestration.reply',
      { from: 'term_coord', id: questionId, body: 'Nothing else.' },
      ctx
    )
    const resume = () =>
      harness.call('orchestration.ask', { from: 'term_worker', resume: questionId }, ctx)

    // A later worker in the same pane cannot take another Dispatch's answer.
    await expect(resume()).rejects.toMatchObject({ code: 'question_not_found' })
    db.db
      .prepare('UPDATE dispatch_contexts SET follow_up_of_dispatch_id = ? WHERE id = ?')
      .run(dispatch.id, later.id)
    await expect(resume()).resolves.toMatchObject({ answer: 'Nothing else.' })
  })

  const PANE = 'tab_worker:leaf_worker'

  // A remote worker this host ran in the pane's process, settled.
  function finishRemoteWorker(
    db: OrchestrationDb,
    processIncarnation: string,
    dispatchId = 'ctx_remote'
  ): void {
    db.createRemoteDispatchAttachment({
      dispatchId,
      runId: 'run_home',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer_fp',
      protocolVersion: 1,
      runtimeEpoch: 'epoch_1',
      mutationReceipt: {
        callerFingerprint: 'peer_fp',
        requestId: `attach_${dispatchId}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_payload'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId,
      paneKey: PANE,
      processIncarnation,
      worktreeId: 'folder_workspace',
      terminalHandle: 'term_worker',
      setupState: 'not_applicable',
      effects: []
    })
    db.markRemoteAttachmentReady(dispatchId)
    db.settleRemoteAttachmentInRelayTransaction(dispatchId, 'succeeded')
  }

  // A local worker this host ran in the pane's process, finished unless still working.
  async function localWorker(
    db: OrchestrationDb,
    ctx: RpcContext,
    processIncarnation: string,
    finished = true
  ): Promise<{ runId: string; dispatchId: string }> {
    const run = db.createRun({
      objective: 'local',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ spec: 'local work', runId: run.id })
    const dispatch = createRootDispatch(
      db,
      task.id,
      'term_worker',
      PANE,
      undefined,
      processIncarnation
    )
    if (finished) {
      await harness.call(
        'orchestration.send',
        {
          from: 'term_worker',
          type: 'worker_done',
          subject: 'Done',
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: dispatch.id,
            outcome: 'succeeded'
          })
        },
        ctx
      )
    }
    return { runId: run.id, dispatchId: dispatch.id }
  }

  it('tells a finished worker on a paired host that its coordinator is out of reach', async () => {
    const { db, runtime, ctx } = harness.setup(false)
    finishRemoteWorker(db, 'runtime_test:term_worker:1')
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? PANE : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:1')

    for (const [method, params] of [
      ['orchestration.send', { subject: 'Later' }],
      ['orchestration.send', { to: 'dispatch:ctx_remote', subject: 'To my own Dispatch' }],
      ['orchestration.ask', { question: 'Anything else?', wait: false }]
    ] as const) {
      await expect(
        harness.call(method, { from: 'term_worker', ...params }, ctx)
      ).rejects.toMatchObject({ code: 'run_home_unreachable' })
    }
  })

  it('never guesses between a remote and a local Dispatch the terminal holds', async () => {
    const { db, runtime, ctx } = harness.setup(false)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? PANE : null
    )
    const runs = vi.mocked(runtime.getTerminalProcessIncarnation)
    const send = (params: Record<string, unknown> = {}) =>
      harness.call('orchestration.send', { from: 'term_worker', subject: 'Later', ...params }, ctx)
    const ask = () =>
      harness.call(
        'orchestration.ask',
        { from: 'term_worker', question: 'More?', wait: false },
        ctx
      )

    runs.mockReturnValue('runtime_test:term_worker:1')
    const local = await localWorker(db, ctx, 'runtime_test:term_worker:1')
    finishRemoteWorker(db, 'runtime_test:term_worker:1')
    await expect(send()).rejects.toMatchObject({ code: 'recipient_ambiguous' })
    await expect(ask()).rejects.toMatchObject({ code: 'recipient_ambiguous' })
    await expect(send({ to: `dispatch:${local.dispatchId}` })).resolves.toMatchObject({
      message: { to_handle: `run:${local.runId}` }
    })

    // A local worker working there names its coordinator the same way.
    const working = await localWorker(db, ctx, 'runtime_test:term_worker:1', false)
    const refused = send().catch((error: unknown) => error)
    await expect(refused).resolves.toMatchObject({ code: 'recipient_ambiguous' })
    const named = String(((await refused) as Error).message).match(/--to (\S+)\.$/)?.[1]
    await expect(send({ to: named })).resolves.toMatchObject({ message: { run_id: working.runId } })
  })

  it('finds the remote worker by the process it ran in, not the newest remote row', async () => {
    const { db, runtime, ctx } = harness.setup(false)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? PANE : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:1')
    finishRemoteWorker(db, 'runtime_test:term_worker:1', 'ctx_remote_ran_here')
    finishRemoteWorker(db, 'runtime_test:term_worker:9', 'ctx_remote_elsewhere')
    await expect(
      harness.call('orchestration.send', { from: 'term_worker', subject: 'Later' }, ctx)
    ).rejects.toMatchObject({
      code: 'run_home_unreachable',
      message: expect.stringContaining('ctx_remote_ran_here')
    })
  })

  it('lets a new process in the pane speak as its own local worker', async () => {
    const { db, runtime, ctx } = harness.setup(false)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? PANE : null
    )
    finishRemoteWorker(db, 'runtime_test:term_worker:1')
    vi.mocked(runtime.getTerminalProcessIncarnation).mockReturnValue('runtime_test:term_worker:2')
    const local = await localWorker(db, ctx, 'runtime_test:term_worker:2')
    await expect(
      harness.call('orchestration.send', { from: 'term_worker', subject: 'Later' }, ctx)
    ).resolves.toMatchObject({ message: { to_handle: `run:${local.runId}` } })
  })

  it('reaches the coordinator of the last worker in the pane after its tab moved and came back', async () => {
    const { db, runtime, ctx } = harness.setup(false)
    const finish = async (handle: string, paneKey: string) => {
      const run = db.createRun({
        objective: handle,
        coordinatorHandle: 'term_coord',
        coordinatorPaneKey: null
      })
      const task = db.createTask({ spec: handle, runId: run.id })
      const dispatch = createRootDispatch(db, task.id, handle, paneKey)
      vi.mocked(runtime.getTerminalPaneKey).mockReturnValue(paneKey)
      await harness.call(
        'orchestration.send',
        {
          from: handle,
          type: 'worker_done',
          subject: 'Done',
          payload: JSON.stringify({
            taskId: task.id,
            dispatchId: dispatch.id,
            outcome: 'succeeded'
          })
        },
        ctx
      )
      return run.id
    }
    await finish('term_first', 'tab_home:cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    const last = await finish('term_moved', 'tab_away:cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    // Back in its first tab under a new handle, the pane is still the last worker's.
    vi.mocked(runtime.getTerminalPaneKey).mockReturnValue(
      'tab_home:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    )
    await expect(
      harness.call('orchestration.send', { from: 'term_back', subject: 'Later' }, ctx)
    ).resolves.toMatchObject({ message: { to_handle: `run:${last}` } })
  })

  it('takes only the chat session that finished for the finished worker', async () => {
    const { db, runtime, ctx, activeRunId } = harness.setup()
    const task = db.createTask({ spec: 'work' })
    const dispatch = createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
    db.db
      .prepare('UPDATE dispatch_contexts SET assignee_orca_session_id = ? WHERE id = ?')
      .run(testOrcaSessionId('chat_worker'), dispatch.id)
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
    )
    const send = (session: string, params: Record<string, unknown>) =>
      harness.call(
        'orchestration.send',
        { from: 'term_worker', ...params },
        { ...ctx, orchestrationCaller: sessionCaller(session) }
      )
    await send('chat_worker', {
      type: 'worker_done',
      subject: 'Done',
      payload: JSON.stringify({ taskId: task.id, dispatchId: dispatch.id, outcome: 'succeeded' })
    })

    await expect(send('chat_other', { subject: 'Not mine' })).rejects.toMatchObject({
      code: 'run_required'
    })
    await send('chat_worker', { subject: 'Mine' })
    expect(db.getUnreadMessages(`run:${activeRunId}`).map((message) => message.subject)).toEqual([
      'Done',
      'Mine'
    ])
  })
})
