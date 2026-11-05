import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
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

  it('tells a finished worker on a paired host that its coordinator is out of reach', async () => {
    const { db, runtime, ctx } = harness.setup(false)
    db.createRemoteDispatchAttachment({
      dispatchId: 'ctx_remote',
      runId: 'run_home',
      taskId: 'task_remote',
      homePeerFingerprint: 'peer_fp',
      protocolVersion: 1,
      runtimeEpoch: 'epoch_1',
      mutationReceipt: {
        callerFingerprint: 'peer_fp',
        requestId: 'attach_1',
        method: 'orchestration.federationAttachStart',
        payloadHash: 'attach_payload'
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: 'ctx_remote',
      paneKey: 'tab_worker:leaf_worker',
      processIncarnation: 'runtime_test:term_worker:1',
      worktreeId: 'folder_workspace',
      terminalHandle: 'term_worker',
      setupState: 'not_applicable',
      effects: []
    })
    db.markRemoteAttachmentReady('ctx_remote')
    db.settleRemoteAttachmentInRelayTransaction('ctx_remote', 'succeeded')
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
    )

    for (const [method, params] of [
      ['orchestration.send', { subject: 'Later' }],
      ['orchestration.send', { to: 'dispatch:ctx_remote', subject: 'To my own Dispatch' }],
      ['orchestration.ask', { question: 'Anything else?', wait: false }]
    ] as const) {
      await expect(
        harness.call(method, { from: 'term_worker', ...params }, ctx)
      ).rejects.toMatchObject({ code: 'run_home_unreachable' })
    }

    // A local worker the pane is given later speaks for it, not the settled remote one.
    const run = db.createRun({
      objective: 'local',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: null
    })
    const task = db.createTask({ spec: 'local work', runId: run.id })
    createRootDispatch(db, task.id, 'term_worker', 'tab_worker:leaf_worker')
    await expect(
      harness.call('orchestration.send', { from: 'term_worker', subject: 'Local' }, ctx)
    ).resolves.toMatchObject({ message: { to_handle: `run:${run.id}` } })
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
