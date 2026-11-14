import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createRootDispatch } from '../../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationWorkerReleaseHarness } from '../testing/worker-release.test-support'

export function registerWorkerListRunScopeRpcTests(): void {
  type WorkerListReceipt = { workers: { dispatchId: string; runId: string }[] }

  /** Exercise the CLI's two scope RPCs over real OrchestrationDb; CLI coverage lives in its own tsconfig project. */
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

  // Plain dispatch has no worker row; retry must still recover its abandoned Task.
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
  })

  // Self-recorded context delegates nothing and cannot identify the coordinator's parent Attempt.
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
  })

  type ListedWorker = {
    dispatchId: string
    workerState: string
    dispatchStatus: string
    projection: {
      outcome: string
      liveness: { verdict: string; reason?: string }
      nextAction: { kind: string; argv: string[] }
      attention: { categories: string[]; requiresAction: boolean }
    }
  }

  describe('pre-v3 dispatch rows in worker-list', () => {
    const h = createOrchestrationWorkerReleaseHarness()

    afterEach(() => h.cleanup())

    async function listWorkers(): Promise<Map<string, ListedWorker>> {
      const listed = (await h.call('orchestration.workerList', {
        paginate: true,
        run: h.activeRunId
      })) as { workers: ListedWorker[] }
      return new Map(listed.workers.map((worker) => [worker.dispatchId, worker]))
    }

    it.each(['completed', 'failed'] as const)(
      'closes a pending question when a legacy dispatch settles as %s',
      async (status) => {
        h.setup()
        const task = h.db.createTask({
          spec: `legacy ${status} with question`,
          runId: h.activeRunId
        })
        const dispatch = createRootDispatch(h.db, task.id, `term_legacy_q_${status}`)
        const asked = h.db.createQuestion({
          runId: h.activeRunId,
          dispatchId: dispatch.id,
          askerHandle: `term_legacy_q_${status}`,
          question: 'Which branch?'
        })
        // Both settlement paths a pre-v3 dispatch can take: the task-status path and failDispatch.
        if (status === 'completed') {
          h.db.updateTaskStatus(task.id, 'completed', 'done')
        } else {
          h.db.failDispatch(dispatch.id, 'legacy failure')
        }

        const worker = (await listWorkers()).get(dispatch.id)!

        expect(h.db.getQuestion(asked.question.message_id)?.status).toBe('closed')
        expect(worker.dispatchStatus).toBe(status)
        expect(worker.projection.attention.categories).not.toContain('input')
        // Nothing can answer a question on a settled Dispatch, so `input` must not outlive it.
        expect(worker.projection.attention.requiresAction).toBe(status === 'failed')
      }
    )
  })
}
