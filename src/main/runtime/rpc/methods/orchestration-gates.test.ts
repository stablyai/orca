import { describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../dispatcher'
import type { RpcRequest, RpcResponse } from '../core'
import { ORCHESTRATION_GATE_METHODS } from './orchestration-gates'
import { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'

// Why (#4389): the start/stop guard must scope by workspace so two orchestrators
// in different worktrees of one Orca instance neither block nor stop each other.
// A fake runtime maps each worktree selector to a stable workspace key and
// stubs the CoordinatorRuntime surface so the background loop can start without
// touching real terminals or git.

function makeRequest(method: string, params: unknown = {}): RpcRequest {
  return { id: `req_${method}`, authToken: 'tok', method, params }
}

function expectOk(response: RpcResponse): Extract<RpcResponse, { ok: true }> {
  if (!response.ok) {
    throw new Error(`expected ok response, got error: ${response.error.message}`)
  }
  return response
}

function expectError(response: RpcResponse, message: RegExp): Extract<RpcResponse, { ok: false }> {
  if (response.ok) {
    throw new Error(`expected error response, got ok: ${JSON.stringify(response.result)}`)
  }
  expect(response.error.message).toMatch(message)
  return response
}

function runId(response: RpcResponse): string {
  return (expectOk(response).result as { runId: string }).runId
}

// Maps `worktree:wt_a` style selectors straight through; the coordinator loop's
// terminal calls are no-ops so dispatchReadyTasks stays inert and harmless.
function makeRuntime(db: OrchestrationDb): OrcaRuntimeService {
  return {
    getRuntimeId: () => 'test-runtime',
    getOrchestrationDb: () => db,
    resolveWorkspaceKeyForSelector: vi.fn(async (selector?: string | null) =>
      selector ? selector : null
    ),
    // CoordinatorRuntime surface — no terminals available, so the loop just
    // polls without dispatching anything.
    listTerminals: vi.fn(async () => ({ terminals: [] })),
    createTerminal: vi.fn(async () => {
      throw new Error('no terminals in test')
    }),
    sendTerminal: vi.fn(async () => ({})),
    waitForTerminal: vi.fn(async (handle: string) => ({ handle, condition: 'idle' })),
    probeWorktreeDrift: vi.fn(async () => null)
  } as unknown as OrcaRuntimeService
}

// Why: orchestration.run fires the coordinator loop in the background. A short
// poll interval plus runStop for each started workspace lets every loop observe
// `stopped` and finish its final DB write before the test closes the DB, so no
// post-close write leaks as an unhandled rejection.
const SHORT_POLL_MS = 5

async function stopAndDrain(
  dispatcher: RpcDispatcher,
  db: OrchestrationDb,
  worktrees: (string | undefined)[]
): Promise<void> {
  for (const worktree of worktrees) {
    await dispatcher.dispatch(makeRequest('orchestration.runStop', worktree ? { worktree } : {}))
  }
  await vi.waitFor(() => expect(db.listActiveCoordinatorRuns()).toHaveLength(0))
}

describe('orchestration start/stop guard scoping (#4389)', () => {
  it('does not reject a run in worktree B while a run is active in worktree A', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      // Each workspace owns its own ready task so the coordinator's decompose
      // step finds work instead of throwing "No tasks found".
      db.createTask({ spec: 'a-work', workspaceKey: 'worktree:wt_a' })
      db.createTask({ spec: 'b-work', workspaceKey: 'worktree:wt_b' })

      const runAId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'a',
            from: 'coord_a',
            worktree: 'worktree:wt_a',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )

      // The 2nd run in a different workspace must succeed, not throw
      // "Coordinator already running".
      const runBId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'b',
            from: 'coord_b',
            worktree: 'worktree:wt_b',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )

      expect(runAId).not.toBe(runBId)
      expect(db.getActiveCoordinatorRun('worktree:wt_a')?.id).toBe(runAId)
      expect(db.getActiveCoordinatorRun('worktree:wt_b')?.id).toBe(runBId)

      await stopAndDrain(dispatcher, db, ['worktree:wt_a', 'worktree:wt_b'])
    } finally {
      db.close()
    }
  })

  it('treats --worktree all as the explicit global coordinator scope', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      db.createTask({ spec: 'global-work' })

      const globalRunId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'global',
            from: 'coord_global',
            worktree: 'all',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )

      expect(db.getCoordinatorRun(globalRunId)?.workspace_key).toBeNull()
      expect(db.getActiveGlobalCoordinatorRun()?.id).toBe(globalRunId)

      db.createTask({ spec: 'a-work', workspaceKey: 'worktree:wt_a' })
      expectError(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'scoped',
            from: 'coord_a',
            worktree: 'worktree:wt_a',
            pollIntervalMs: SHORT_POLL_MS
          })
        ),
        /Coordinator already running/
      )

      await stopAndDrain(dispatcher, db, ['all'])
    } finally {
      db.close()
    }
  })

  it('does not fall back to the global coordinator when an explicit worktree selector fails', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    vi.mocked(runtime.resolveWorkspaceKeyForSelector).mockRejectedValueOnce(
      new Error('selector_not_found')
    )
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      const response = await dispatcher.dispatch(
        makeRequest('orchestration.run', {
          spec: 'missing worktree',
          from: 'coord_missing',
          worktree: 'branch:missing'
        })
      )

      expect(response.ok).toBe(false)
      expect(db.getActiveCoordinatorRun()).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('rejects a second run in the SAME worktree', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      db.createTask({ spec: 'a-work', workspaceKey: 'worktree:wt_a' })

      expectOk(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'a',
            from: 'coord_a',
            worktree: 'worktree:wt_a',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )
      const second = await dispatcher.dispatch(
        makeRequest('orchestration.run', {
          spec: 'a2',
          from: 'coord_a2',
          worktree: 'worktree:wt_a',
          pollIntervalMs: SHORT_POLL_MS
        })
      )
      expectError(second, /Coordinator already running/)

      await stopAndDrain(dispatcher, db, ['worktree:wt_a'])
    } finally {
      db.close()
    }
  })

  it('runStop for worktree B leaves worktree A running', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      db.createTask({ spec: 'a-work', workspaceKey: 'worktree:wt_a' })
      db.createTask({ spec: 'b-work', workspaceKey: 'worktree:wt_b' })

      const runAId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'a',
            from: 'coord_a',
            worktree: 'worktree:wt_a',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )
      expectOk(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'b',
            from: 'coord_b',
            worktree: 'worktree:wt_b',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )

      const stopB = expectOk(
        await dispatcher.dispatch(
          makeRequest('orchestration.runStop', { worktree: 'worktree:wt_b' })
        )
      )
      expect((stopB.result as { stopped: boolean }).stopped).toBe(true)

      // A's run must still be the active run for its workspace after stopping B.
      expect(db.getActiveCoordinatorRun('worktree:wt_a')?.id).toBe(runAId)

      await stopAndDrain(dispatcher, db, ['worktree:wt_a'])
    } finally {
      db.close()
    }
  })

  it('runStop --worktree all stops the global coordinator exactly', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      db.createTask({ spec: 'global-work' })
      const globalRunId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'global',
            from: 'coord_global',
            worktree: 'all',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )

      const stopGlobal = expectOk(
        await dispatcher.dispatch(makeRequest('orchestration.runStop', { worktree: 'all' }))
      )

      expect((stopGlobal.result as { runId: string }).runId).toBe(globalRunId)
      await vi.waitFor(() => {
        expect(db.getCoordinatorRun(globalRunId)?.status).toBe('failed')
      })
    } finally {
      db.close()
    }
  })

  it('runStop with a scoped worktree does not match the global coordinator', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      db.createTask({ spec: 'global-work' })
      const globalRunId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'global',
            from: 'coord_global',
            worktree: 'all',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )

      expectError(
        await dispatcher.dispatch(
          makeRequest('orchestration.runStop', { worktree: 'worktree:wt_a' })
        ),
        /No active coordinator run for requested worktree/
      )
      expect(db.getActiveGlobalCoordinatorRun()?.id).toBe(globalRunId)

      await stopAndDrain(dispatcher, db, ['all'])
    } finally {
      db.close()
    }
  })

  it('runStop with no worktree stops the only active scoped coordinator', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      db.createTask({ spec: 'a-work', workspaceKey: 'worktree:wt_a' })
      const runAId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'a',
            from: 'coord_a',
            worktree: 'worktree:wt_a',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )

      const stopOnlyRun = expectOk(await dispatcher.dispatch(makeRequest('orchestration.runStop')))

      expect((stopOnlyRun.result as { runId: string }).runId).toBe(runAId)
      await vi.waitFor(() => {
        expect(db.getCoordinatorRun(runAId)?.status).toBe('failed')
      })
    } finally {
      db.close()
    }
  })

  it('runStop with no worktree rejects multiple active scoped coordinators', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = makeRuntime(db)
    const dispatcher = new RpcDispatcher({ runtime, methods: ORCHESTRATION_GATE_METHODS })
    try {
      db.createTask({ spec: 'a-work', workspaceKey: 'worktree:wt_a' })
      db.createTask({ spec: 'b-work', workspaceKey: 'worktree:wt_b' })
      const runAId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'a',
            from: 'coord_a',
            worktree: 'worktree:wt_a',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )
      const runBId = runId(
        await dispatcher.dispatch(
          makeRequest('orchestration.run', {
            spec: 'b',
            from: 'coord_b',
            worktree: 'worktree:wt_b',
            pollIntervalMs: SHORT_POLL_MS
          })
        )
      )

      expectError(
        await dispatcher.dispatch(makeRequest('orchestration.runStop')),
        /Multiple active coordinator runs/
      )
      expect(db.getActiveCoordinatorRunForWorkspace('worktree:wt_a')?.id).toBe(runAId)
      expect(db.getActiveCoordinatorRunForWorkspace('worktree:wt_b')?.id).toBe(runBId)

      await stopAndDrain(dispatcher, db, ['worktree:wt_a', 'worktree:wt_b'])
    } finally {
      db.close()
    }
  })
})
