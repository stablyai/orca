import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

type WorkerListReceipt = { workers: { dispatchId: string; runId: string }[] }

/** The runtime half of the worker-list scope seam: the two RPC questions the CLI handler asks
 *  (`cli/handlers/orchestration/worker-list-run-scope.ts`) over a real OrchestrationDb. The CLI
 *  half lives beside the handler; the two cannot share one file across tsconfig projects. */
describe('orchestration worker-list Run scope (runtime)', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  beforeEach(() => h.setup())
  afterEach(() => h.cleanup())

  function createDispatchInRun(runId: string, handle: string): string {
    const task = h.db.createTask({ spec: `task for ${handle}`, runId })
    return createRootDispatch(h.db, task.id, handle).id
  }

  function createOtherRun(): string {
    return h.db.createRun({
      objective: 'Another Run',
      coordinatorHandle: 'term_other',
      coordinatorPaneKey: 'tab_other:cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    }).id
  }

  it('resolves the bound Run from the coordinator handle and lists only its dispatches', async () => {
    const boundDispatch = createDispatchInRun(h.activeRunId, 'term_bound')
    const otherDispatch = createDispatchInRun(createOtherRun(), 'term_unbound')

    const current = (await h.call('orchestration.runCurrent', { from: 'term_coord' })) as {
      run: { id: string } | null
    }
    expect(current.run?.id).toBe(h.activeRunId)

    const listed = (await h.call('orchestration.workerList', {
      paginate: true,
      run: current.run!.id
    })) as WorkerListReceipt
    expect(listed.workers.map((worker) => worker.dispatchId)).toEqual([boundDispatch])
    expect(listed.workers.map((worker) => worker.dispatchId)).not.toContain(otherDispatch)
  })

  it('refuses runCurrent for an unbound handle, and an unscoped list spans every Run', async () => {
    const boundDispatch = createDispatchInRun(h.activeRunId, 'term_bound')
    const otherDispatch = createDispatchInRun(createOtherRun(), 'term_unbound')

    // The CLI's catch turns this refusal into `scope.source = 'all'`.
    await expect(
      h.call('orchestration.runCurrent', { from: 'term_unbound_shell' })
    ).rejects.toThrow(/no stable pane identity/)

    const listed = (await h.call('orchestration.workerList', {
      paginate: true
    })) as WorkerListReceipt
    expect(listed.workers.map((worker) => worker.dispatchId).sort()).toEqual(
      [boundDispatch, otherDispatch].sort()
    )
  })
})
