import { afterEach, describe, expect, it } from 'vitest'
import { createRootDispatch } from '../../../../orchestration/db/root-dispatch-test-fixture'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

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

  /** A pre-v3 dispatch: a real dispatch_contexts row settled through the real lifecycle with no
   *  worker_dispatches row, which is what every dispatch made before supervised workers looks like. */
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
    // `dispatch_contexts.status = 'completed'` is only written from an accepted `succeeded`
    // report or a task completion, so the durable record is the whole settlement.
    expect(worker.projection.outcome).toBe('succeeded')
    // Absence is not a death certificate, so the verdict stays unverifiable — but a dispatch
    // that never had a worker row has no process whose absence could require action.
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
      const task = h.db.createTask({ spec: `legacy ${status} with question`, runId: h.activeRunId })
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
