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
})
