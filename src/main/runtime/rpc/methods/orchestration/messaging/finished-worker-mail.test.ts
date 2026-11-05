import { afterEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'

describe('a worker after its worker_done', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

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
      handle === 'term_worker' ? 'tab_worker:leaf_worker' : null
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
    const asked = await harness.call(
      'orchestration.ask',
      { from: 'term_worker', question: 'Anything else?', wait: false },
      ctx
    )

    expect(again).toMatchObject({ lifecycle: { action: 'settled', outcome: 'succeeded' } })
    expect(asked).toMatchObject({ pending: true })
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
      ['orchestration.ask', { question: 'Anything else?', wait: false }]
    ] as const) {
      await expect(
        harness.call(method, { from: 'term_worker', ...params }, ctx)
      ).rejects.toMatchObject({ code: 'run_home_unreachable' })
    }
  })
})
