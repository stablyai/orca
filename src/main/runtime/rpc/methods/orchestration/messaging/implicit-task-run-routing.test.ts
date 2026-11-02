import '../../../unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationRpcHarness } from '../rpc-test-harness'
import { mapRuntimeError } from '../../../errors'

describe('implicit task-scoped message routing', () => {
  const harness = createOrchestrationRpcHarness()
  afterEach(() => harness.cleanup())

  function setup(sender: 'coordinator' | 'worker' = 'coordinator') {
    const state = harness.setup()
    const ownTask = state.db.createTask({ spec: 'Sender work' })
    const otherRun = state.db.createRun({
      objective: 'Other Run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:leaf_other'
    })
    const otherTask = state.db.createTask({ runId: otherRun.id, spec: 'Other Run work' })
    const from = sender === 'worker' ? 'term_worker' : 'term_coord'
    let dispatchId: string | undefined
    if (sender === 'worker') {
      const paneKey = 'tab_worker:leaf_worker'
      dispatchId = createRootDispatch(state.db, ownTask.id, from, paneKey).id
      vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
        handle === from ? paneKey : null
      )
    }
    const send = (params: Record<string, unknown> = {}) =>
      harness.call(
        'orchestration.send',
        { from, type: 'status', subject: 'Task progress', ...params },
        state.ctx
      )
    return { ...state, ownTask, otherTask, otherRun, from, dispatchId, send }
  }

  it.each(['coordinator', 'worker'] as const)(
    'refuses a %s message naming another Run task before writing or waking mail',
    async (sender) => {
      const { db, runtime, otherTask, otherRun, activeRunId, send } = setup(sender)
      const notify = vi.spyOn(runtime, 'notifyMessageArrived')

      const error = await send({ payload: JSON.stringify({ taskId: otherTask.id }) }).catch(
        (caught: unknown) => caught
      )
      expect(mapRuntimeError('req', { runtimeId: 'runtime' }, error).error).toMatchObject({
        code: 'task_run_mismatch',
        message: expect.stringContaining(
          `Task ${otherTask.id} belongs to Run ${otherRun.id}, not the inferred Run ${activeRunId}.`
        )
      })

      expect(db.getInbox(100)).toEqual([])
      expect(notify).not.toHaveBeenCalled()
      expect(db.getTask(otherTask.id)?.status).toBe('ready')
    }
  )

  it.each(['coordinator', 'worker'] as const)(
    'persists a %s message for its own task in the inferred Run',
    async (sender) => {
      const { db, ownTask, activeRunId, from, send } = setup(sender)
      await send({ payload: JSON.stringify({ taskId: ownTask.id }) })

      expect(db.getInbox(100)).toEqual([
        expect.objectContaining({
          from_handle: from,
          to_handle: `run:${activeRunId}`,
          run_id: activeRunId
        })
      ])
    }
  )

  it.each(['recipient', 'run'] as const)(
    'preserves explicit cross-Run delivery selected by %s',
    async (selection) => {
      const { db, otherRun, ownTask, send } = setup()
      await send({
        ...(selection === 'recipient' ? { to: `run:${otherRun.id}` } : { run: otherRun.id }),
        payload: JSON.stringify({ taskId: ownTask.id })
      })

      expect(db.getInbox(100)).toEqual([
        expect.objectContaining({ run_id: otherRun.id, to_handle: `run:${otherRun.id}` })
      ])
    }
  )

  it.each([
    ['explicit', 'worker_done', 'task_dispatch_mismatch'],
    ['implicit', 'worker_done', 'missing_dispatch_id'],
    ['implicit', 'escalation', 'task_dispatch_mismatch']
  ] as const)(
    'leaves a stale Task on an %s Dispatch %s to lifecycle rejection in the Dispatch Run',
    async (scope, type, code) => {
      const { db, otherTask, activeRunId, dispatchId, send } = setup('worker')
      const receipt = await send({
        type,
        payload: JSON.stringify({
          taskId: otherTask.id,
          outcome: 'succeeded',
          ...(scope === 'explicit' ? { dispatchId } : {})
        })
      })

      expect(receipt).toMatchObject({ lifecycle: { action: 'rejected', code } })
      expect(db.getInbox(100)).toEqual([expect.objectContaining({ run_id: activeRunId })])
    }
  )

  it('lets a nested coordinator report its child Run task to its parent Run', async () => {
    const { db, activeRunId, from, send } = setup('worker')
    const childRun = db.createRun({
      objective: 'Child Run',
      coordinatorHandle: from,
      coordinatorPaneKey: 'tab_worker:leaf_worker'
    })
    const childTask = db.createTask({ runId: childRun.id, spec: 'Child work' })

    await send({ payload: JSON.stringify({ taskId: childTask.id }) })

    expect(db.getInbox(100)).toEqual([
      expect.objectContaining({ run_id: activeRunId, to_handle: `run:${activeRunId}` })
    ])
  })

  it('preserves explicit terminal delivery when the payload references a foreign task', async () => {
    const { db, otherTask, activeRunId, runtime, send } = setup()
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_recipient' ? 'tab_recipient:leaf_recipient' : harness.coordinatorPaneKey
    )

    await send({ to: 'term_recipient', payload: JSON.stringify({ taskId: otherTask.id }) })

    expect(db.getInbox(100)).toEqual([
      expect.objectContaining({ run_id: activeRunId, to_handle: 'term_recipient' })
    ])
  })

  it.each([undefined, '{', '{"taskId":"task_unknown"}'])(
    'preserves existing status-message behavior for payload %s',
    async (payload) => {
      const { db, activeRunId, send } = setup()
      await send({ payload })

      expect(db.getInbox(100)).toEqual([
        expect.objectContaining({ run_id: activeRunId, to_handle: `run:${activeRunId}` })
      ])
    }
  )
})
