import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

// A coordinator that records context against its own terminal delegated nothing, so the row it
// leaves behind must not read back as the coordinator's own parent Attempt.
describe('context-only self-dispatch and nesting depth', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  async function selfDispatch(): Promise<string> {
    const task = harness.db.createTask({ spec: 'self bookkeeping', runId: harness.activeRunId })
    const result = (await harness.call('orchestration.dispatch', {
      task: task.id,
      from: 'term_coord',
      to: 'term_coord'
    })) as { dispatch: { id: string } }
    return result.dispatch.id
  }

  it('leaves the coordinator able to start a worker', async () => {
    const selfDispatchId = await selfDispatch()
    expect(harness.db.getDispatchContextById(selfDispatchId)).toMatchObject({
      creator_handle: 'term_coord',
      creator_pane_key: harness.coordinatorPaneKey
    })

    const started = await harness.startWorker({ terminal: 'term_worker' })

    expect(harness.db.getDispatchContextById(started.dispatchId)).toMatchObject({
      depth: 1,
      creator_dispatch_id: null
    })
  })

  it('still counts a real assignment to another pane as a nesting parent', async () => {
    const task = harness.db.createTask({ spec: 'real delegation', runId: harness.activeRunId })
    const delegated = (await harness.call('orchestration.dispatch', {
      task: task.id,
      from: 'term_coord',
      to: 'term_worker'
    })) as { dispatch: { id: string } }

    expect(
      harness.db.resolveCreatorDepth({
        kind: 'terminal',
        handle: 'term_worker',
        paneKey: harness.workerPaneKey
      })
    ).toBe(1)
    expect(
      harness.db.resolveCreatorDispatchId({
        kind: 'terminal',
        handle: 'term_worker',
        paneKey: harness.workerPaneKey
      })
    ).toBe(delegated.dispatch.id)
  })

  it('reports the self-dispatching coordinator as a root', async () => {
    await selfDispatch()

    const creator = {
      kind: 'terminal',
      handle: 'term_coord',
      paneKey: harness.coordinatorPaneKey
    } as const
    expect(harness.db.resolveCreatorDepth(creator)).toBe(0)
    expect(harness.db.resolveCreatorDispatchId(creator)).toBeNull()
  })
})
