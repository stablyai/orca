import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './orchestration/rpc-test-harness'
import type { OrchestrationRpcState } from './orchestration/rpc-test-harness'

const released: string[] = []

vi.mock('./orchestration-structured-worker-session', () => ({
  releaseStructuredWorkerSession: (dispatchId: string) => released.push(dispatchId),
  createStructuredWorkerSession: vi.fn(),
  sendStructuredWorkerPreamble: vi.fn(),
  structuredWorkerHoldId: (dispatchId: string) => `orchestration:dispatch:${dispatchId}`
}))

const harness = createOrchestrationRpcHarness()

describe('workerAbandon settles the structured hold', () => {
  let state: OrchestrationRpcState

  beforeEach(() => {
    released.length = 0
    state = harness.setup()
  })

  afterEach(() => {
    harness.cleanup()
    vi.restoreAllMocks()
  })

  async function startedDispatch(): Promise<string> {
    const task = state.db.createTask({ spec: 'do it' })
    const started = state.db.createStartingWorkerDispatch({
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER,
      taskId: task.id,
      startOptions: {}
    })
    return started.dispatch.id
  }

  it('releases the hold when the dispatch actually settles', async () => {
    const dispatchId = await startedDispatch()
    // Without this, the resume-capable hold outlives settlement: the provider child can never be
    // evicted and host crash recovery keeps respawning an abandoned worker.
    await harness.call('orchestration.workerAbandon', { dispatch: dispatchId }, state.ctx)
    expect(released).toEqual([dispatchId])
  })

  it('does not release twice when the dispatch was already settled', async () => {
    const dispatchId = await startedDispatch()
    await harness.call('orchestration.workerAbandon', { dispatch: dispatchId }, state.ctx)
    await harness.call('orchestration.workerAbandon', { dispatch: dispatchId }, state.ctx)
    expect(released).toEqual([dispatchId])
  })
})
