import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

// A plain orchestration.dispatch attempt has no worker_dispatches row, so the retry precondition
// used to reject it and its abandoned Task had no documented route back.
describe('worker-start --retry-of a context-only Dispatch', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  async function dispatchContextOnly(
    spec: string
  ): Promise<{ taskId: string; dispatchId: string }> {
    const task = harness.db.createTask({ spec, runId: harness.activeRunId })
    const result = (await harness.call('orchestration.dispatch', {
      task: task.id,
      from: 'term_coord',
      to: 'term_worker'
    })) as { dispatch: { id: string } }
    expect(harness.db.getWorkerDispatch(result.dispatch.id)).toBeUndefined()
    return { taskId: task.id, dispatchId: result.dispatch.id }
  }

  it('restarts the Task after the attempt is abandoned', async () => {
    const { taskId, dispatchId } = await dispatchContextOnly('unsupervised attempt')

    await expect(
      harness.call('orchestration.workerAbandon', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'abandoned', alreadySettled: false })
    expect(harness.db.getTask(taskId)?.status).toBe('blocked')

    const retried = (await harness.call('orchestration.workerStart', {
      task: taskId,
      from: 'term_coord',
      terminal: 'term_worker',
      retryOf: dispatchId
    })) as { dispatchId: string; state: string }

    expect(retried.state).toBe('ready')
    expect(harness.db.getDispatchContextById(retried.dispatchId)?.retry_of_dispatch_id).toBe(
      dispatchId
    )
    expect(harness.db.getTask(taskId)?.status).toBe('dispatched')
  })

  it('still refuses to retry an attempt that has not settled', async () => {
    const { taskId, dispatchId } = await dispatchContextOnly('live attempt')

    await expect(
      harness.call('orchestration.workerStart', {
        task: taskId,
        from: 'term_coord',
        terminal: 'term_worker',
        retryOf: dispatchId
      })
    ).rejects.toMatchObject({ code: 'task_not_startable' })
  })
})
