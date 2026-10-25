import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { OrchestrationFleetWorker } from '../../../../../../shared/orchestration-fleet-projection'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

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

  type ReadWithProjection = { projection?: OrchestrationFleetWorker | null }

  describe('orchestration worker-read fleet projection', () => {
    const h = createOrchestrationWorkerReleaseHarness()

    afterEach(() => h.cleanup())

    it('publishes the fleet agent verdict beside the PTY verdict on a live read', async () => {
      h.setup()
      const { dispatchId } = await h.startWorker()

      const read = (await h.call('orchestration.workerRead', {
        dispatch: dispatchId
      })) as ReadWithProjection & { status: { liveness?: string } }

      expect(read.projection?.dispatchId).toBe(dispatchId)
      // The agent verdict is not the PTY verdict; worker-read must carry both.
      expect(read.status.liveness).toBe('live')
      expect(read.projection?.liveness.verdict).toBe('unverifiable')
    })

    it('carries the projection on an archived read after release', async () => {
      h.setup()
      const { dispatchId } = await h.startSettledWorker()
      await h.call('orchestration.workerRelease', { dispatch: dispatchId })

      const read = (await h.call('orchestration.workerRead', {
        dispatch: dispatchId
      })) as ReadWithProjection

      expect(read.projection?.dispatchId).toBe(dispatchId)
      expect(read.projection?.liveness.verdict).toBe('exited')
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

    /** Settle real pre-v3 dispatch_contexts without worker_dispatches, matching legacy unsupervised dispatches. */
    function createLegacyDispatch(status: 'completed' | 'failed' | 'dispatched'): string {
      const task = h.db.createTask({ spec: `legacy ${status} task`, runId: h.activeRunId })
      const dispatch = createRootDispatch(h.db, task.id, `term_legacy_${status}`)
      if (status === 'completed') {
        h.db.completeDispatch(dispatch.id)
      }
      if (status === 'failed') {
        h.db.failDispatch(dispatch.id, 'legacy failure')
      }
      return dispatch.id
    }

    async function listWorkers(): Promise<Map<string, ListedWorker>> {
      const listed = (await h.call('orchestration.workerList', {
        paginate: true,
        run: h.activeRunId
      })) as { workers: ListedWorker[] }
      return new Map(listed.workers.map((worker) => [worker.dispatchId, worker]))
    }

    it('projects a settled legacy dispatch as settled with nothing to act on', async () => {
      h.setup()
      const completed = createLegacyDispatch('completed')

      const worker = (await listWorkers()).get(completed)!

      expect(worker.workerState).toBe('unsupervised')
      expect(worker.dispatchStatus).toBe('completed')
      // Completed legacy Dispatch rows already prove accepted success/task completion.
      expect(worker.projection.outcome).toBe('succeeded')
      // No worker row means no process to act on; keep liveness unverifiable because absence still proves no death.
      expect(worker.projection.liveness).toEqual({
        verdict: 'unverifiable',
        reason: 'unsupervised_settled'
      })
      expect(worker.projection.attention.categories).not.toContain('unverifiable')
      expect(worker.projection.attention.requiresAction).toBe(false)
      expect(worker.projection.nextAction.kind).toBe('none')
    })

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

    it('keeps a legacy failed dispatch actionable on the failure, not on absence', async () => {
      h.setup()
      const failed = createLegacyDispatch('failed')

      const worker = (await listWorkers()).get(failed)!

      expect(worker.dispatchStatus).toBe('failed')
      expect(worker.projection.outcome).toBe('failed')
      expect(worker.projection.attention.categories).toEqual(['failure'])
      expect(worker.projection.attention.requiresAction).toBe(true)
    })

    it('leaves an unsettled legacy dispatch genuinely unknown', async () => {
      h.setup()
      const dispatched = createLegacyDispatch('dispatched')

      const worker = (await listWorkers()).get(dispatched)!

      expect(worker.projection.outcome).toBe('in_progress')
      expect(worker.projection.liveness).toEqual({
        verdict: 'unverifiable',
        reason: 'missing_status'
      })
      expect(worker.projection.attention.categories).toContain('unverifiable')
      expect(worker.projection.attention.requiresAction).toBe(true)
      expect(worker.projection.nextAction).toEqual({ kind: 'none', argv: [] })
    })
  })
}
