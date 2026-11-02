import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOrchestrationRpcHarness } from './orchestration/rpc-test-harness'
import type { OrchestrationRpcState } from './orchestration/rpc-test-harness'

const released: unknown[] = []
const SESSION = 'session-abandon'

vi.mock('./orchestration-structured-worker-session', () => ({
  releaseStructuredWorkerSession: (sessionId: unknown) => released.push(sessionId),
  createStructuredWorkerSession: vi.fn(),
  sendStructuredWorkerPreamble: vi.fn()
}))

const harness = createOrchestrationRpcHarness()

describe('workerAbandon settles the structured worker session', () => {
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
    // The authority worker-start records: abandon finds the worker's session by it.
    state.db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'structworker_abandon',
      paneKey: `structured-agent-session-${SESSION}:11111111-1111-4111-a111-111111111111`,
      processIncarnation: `structured:${SESSION}`,
      worktreeId: 'wt_1',
      effects: [],
      setupState: 'not_applicable'
    })
    return started.dispatch.id
  }

  it('releases the worker session when the dispatch actually settles', async () => {
    const dispatchId = await startedDispatch()
    // Without this, the redrive subscription outlives settlement and keeps nudging a session no
    // dispatch owns.
    await harness.call('orchestration.workerAbandon', { dispatch: dispatchId }, state.ctx)
    expect(released).toEqual([SESSION])
  })

  it('does not release twice when the dispatch was already settled', async () => {
    const dispatchId = await startedDispatch()
    await harness.call('orchestration.workerAbandon', { dispatch: dispatchId }, state.ctx)
    await harness.call('orchestration.workerAbandon', { dispatch: dispatchId }, state.ctx)
    expect(released).toEqual([SESSION])
  })
})
