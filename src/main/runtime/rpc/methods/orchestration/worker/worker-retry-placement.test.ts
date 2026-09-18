import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { startFederatedWorker } from '../federation/federated-worker-start'
import { assertRetryOfRepeatsPlacement } from './worker-retry-placement'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'

function placementStore(startOptions?: Record<string, string>): {
  getWorkerDispatch: (id: string) => { start_options: string } | undefined
} {
  return {
    getWorkerDispatch: (id) =>
      id === 'ctx_prior' && startOptions
        ? { start_options: JSON.stringify(startOptions) }
        : undefined
  }
}

function workerStartReceipt(result: unknown): { dispatchId: string; state: string } {
  if (
    typeof result !== 'object' ||
    result === null ||
    !('dispatchId' in result) ||
    !('state' in result) ||
    typeof result.dispatchId !== 'string' ||
    typeof result.state !== 'string'
  ) {
    throw new Error('expected a worker-start receipt')
  }
  return { dispatchId: result.dispatchId, state: result.state }
}

function workerStartOptions(startOptionsJson: string | undefined): unknown {
  return JSON.parse(startOptionsJson ?? '{}')
}

describe('assertRetryOfRepeatsPlacement', () => {
  it('allows omitted placement when this is not a retry', () => {
    expect(() => assertRetryOfRepeatsPlacement({}, placementStore())).not.toThrow()
  })

  it('allows an explicit --worktree current retry', () => {
    expect(() =>
      assertRetryOfRepeatsPlacement({ retryOf: 'ctx_prior', worktree: 'current' }, placementStore())
    ).not.toThrow()
  })

  it('allows --retry-of with --terminal and no --worktree', () => {
    expect(() =>
      assertRetryOfRepeatsPlacement(
        { retryOf: 'ctx_prior', terminal: 'term_worker' },
        placementStore()
      )
    ).not.toThrow()
  })

  it('allows --retry-of with --worktree and no --terminal', () => {
    expect(() =>
      assertRetryOfRepeatsPlacement(
        { retryOf: 'ctx_prior', worktree: 'id:repo::lane' },
        placementStore()
      )
    ).not.toThrow()
  })

  it('refuses omitted placement with the command shape to repeat it', () => {
    expect(() => assertRetryOfRepeatsPlacement({ retryOf: 'ctx_prior' }, placementStore())).toThrow(
      OrchestrationError
    )
    try {
      assertRetryOfRepeatsPlacement({ retryOf: 'ctx_prior' }, placementStore())
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_argument',
        message: expect.stringContaining('does not inherit placement')
      })
      expect(error).toMatchObject({
        message: expect.stringContaining('--worktree <selector>')
      })
      expect(error).toMatchObject({
        message: expect.stringContaining('--terminal <handle>')
      })
      expect(String(error)).not.toContain('Prior attempt')
    }
  })

  it('names the prior resolved worktree when it is on hand', () => {
    expect(() =>
      assertRetryOfRepeatsPlacement(
        { retryOf: 'ctx_prior' },
        placementStore({
          worktree: 'current',
          resolvedWorktreeId: 'repo::lane'
        })
      )
    ).toThrow(/Prior attempt used --worktree id:repo::lane/)
  })

  it('names the prior --worktree selector when no resolved id is recorded', () => {
    expect(() =>
      assertRetryOfRepeatsPlacement(
        { retryOf: 'ctx_prior' },
        placementStore({ worktree: 'id:repo::lane' })
      )
    ).toThrow(/Prior attempt used --worktree id:repo::lane/)
  })

  it('names the prior --terminal when that is the recorded placement', () => {
    expect(() =>
      assertRetryOfRepeatsPlacement(
        { retryOf: 'ctx_prior' },
        placementStore({ terminal: 'term_lane' })
      )
    ).toThrow(/Prior attempt used --terminal term_lane/)
  })

  it('still refuses when prior start_options are missing or malformed', () => {
    expect(() =>
      assertRetryOfRepeatsPlacement(
        { retryOf: 'ctx_prior' },
        { getWorkerDispatch: () => ({ start_options: '{not-json' }) }
      )
    ).toThrow(/does not inherit placement/)
  })
})

describe('worker-start --retry-of without placement', () => {
  const harness = createOrchestrationWorkerReleaseHarness()
  beforeEach(() => harness.setup())
  afterEach(() => harness.cleanup())

  async function startFailedWorker(): Promise<{ taskId: string; dispatchId: string }> {
    const started = await harness.startWorker()
    harness.settle(started.taskId, started.dispatchId, 'failed')
    return started
  }

  it('refuses with invalid_argument instead of landing in the coordinator worktree', async () => {
    const started = await startFailedWorker()

    await expect(
      harness.call('orchestration.workerStart', {
        task: started.taskId,
        from: 'term_coord',
        agent: 'codex',
        retryOf: started.dispatchId
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringMatching(
        /does not inherit placement.*--worktree <selector>.*--terminal <handle>.*--worktree id:repo::worktree/s
      )
    })
    expect(harness.db.getTask(started.taskId)?.status).toBe('failed')
    expect(harness.db.getDispatchContext(started.taskId)?.id).toBe(started.dispatchId)
  })

  it('accepts an explicit --worktree current retry', async () => {
    const started = await startFailedWorker()

    const retried = workerStartReceipt(
      await harness.call('orchestration.workerStart', {
        task: started.taskId,
        from: 'term_coord',
        agent: 'codex',
        worktree: 'current',
        retryOf: started.dispatchId
      })
    )

    expect(retried.state).toBe('ready')
    expect(
      workerStartOptions(harness.db.getWorkerDispatch(retried.dispatchId)?.start_options)
    ).toMatchObject({
      worktree: 'current',
      resolvedWorktreeId: 'repo::worktree'
    })
  })

  it('accepts --retry-of with --worktree and no --terminal', async () => {
    const started = await startFailedWorker()

    const retried = workerStartReceipt(
      await harness.call('orchestration.workerStart', {
        task: started.taskId,
        from: 'term_coord',
        agent: 'codex',
        worktree: 'id:repo::lane',
        retryOf: started.dispatchId
      })
    )

    expect(retried.state).toBe('ready')
    expect(
      workerStartOptions(harness.db.getWorkerDispatch(retried.dispatchId)?.start_options)
    ).toMatchObject({
      worktree: 'id:repo::lane'
    })
  })

  it('accepts --retry-of with --terminal and no --worktree', async () => {
    const started = await startFailedWorker()

    const retried = workerStartReceipt(
      await harness.call('orchestration.workerStart', {
        task: started.taskId,
        from: 'term_coord',
        terminal: 'term_worker',
        retryOf: started.dispatchId
      })
    )

    expect(retried.state).toBe('ready')
    expect(harness.db.getDispatchContextById(retried.dispatchId)?.retry_of_dispatch_id).toBe(
      started.dispatchId
    )
  })

  it('refuses a federated retry that omits placement before defaulting to current', async () => {
    const started = await startFailedWorker()

    await expect(
      startFederatedWorker({
        params: {
          task: started.taskId,
          from: 'term_coord',
          on: 'remote',
          agent: 'codex',
          retryOf: started.dispatchId
        },
        runtime: harness.runtime,
        db: harness.db,
        runId: harness.activeRunId,
        orchestrationMutation: {
          callerFingerprint: 'caller',
          requestId: 'remote_retry',
          method: 'orchestration.workerStart',
          payloadHash: 'payload'
        }
      })
    ).rejects.toMatchObject({
      code: 'invalid_argument',
      message: expect.stringContaining('does not inherit placement')
    })
    expect(harness.db.getTask(started.taskId)?.status).toBe('failed')
  })
})
