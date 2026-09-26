import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../orchestration/preamble', () => ({ buildDispatchPreamble: () => 'preamble' }))
vi.mock('./worker-topology', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  monitorWorkerSetup: () => {}
}))

const { deliverAndSettleWorkerStartReadiness } = await import('./worker-start-readiness-settlement')

function settle(delivered: 'accepted' | undefined) {
  const db = {
    getWorkerDispatch: () => ({ state: 'starting' }),
    markWorkerStartUnknown: vi.fn(() => ({
      stage: 'turn_start_unobserved',
      residual_resources: '[]'
    })),
    markWorkerDispatchReady: vi.fn(() => ({ state: 'ready', stage: 'ready' }))
  }
  const host = {
    deps: { store: { getRecord: () => ({ lease: { runtimeFence: 1 } }) } },
    send: async () => ({
      ok: true,
      value: { clientMessageId: 'c1', submission: { dispatchState: 'pending', reason: null } }
    }),
    // undefined: the worker's agent was still starting when the wait ran out.
    waitForSendSettlement: async () =>
      delivered
        ? { value: { clientMessageId: 'c1', submission: { dispatchState: delivered } } }
        : undefined
  }
  const args = {
    runtime: {
      getNestedWorkerMaxDepth: () => 3,
      getTerminalOrchestrationCliCommand: () => 'orca'
    },
    db,
    run: { id: 'run_1' },
    task: { id: 't1', spec: 'do the thing' },
    dispatchId: 'd1',
    dispatchDepth: 0,
    structuredSession: { host, identity: { sessionId: 's1' } },
    terminalHandle: 'structured_worker_1',
    coordinatorHandle: 'term_c',
    dispatchCapability: 'capability',
    devMode: undefined,
    requestId: 'r1',
    agent: 'claude',
    setupReceipt: {},
    launchReceipt: {},
    mode: {},
    timeoutMs: 60_000,
    effects: [],
    terminalRevealWarning: undefined,
    onStage: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement exactly the runtime, db and host members this settlement reaches.
  const receipt = deliverAndSettleWorkerStartReadiness(args as never)
  return { db, receipt }
}

describe('a structured worker whose agent outlasts the preamble wait', () => {
  it('parks as start-unknown instead of failing the start, and never names a screen to read', async () => {
    const { db, receipt } = settle(undefined)

    // Resolving, not throwing, is what keeps the worker's session: a throw tears it down.
    await expect(receipt).resolves.toMatchObject({
      state: 'outcome_unknown',
      turnStart: 'unobserved',
      nextCommands: [
        'orca orchestration worker-show --dispatch d1 --json',
        'orca orchestration worker-abandon --dispatch d1 --json'
      ]
    })
    expect(db.markWorkerStartUnknown).toHaveBeenCalledWith(
      'd1',
      'turn_start_unobserved',
      expect.stringContaining('delivered when the agent starts'),
      expect.anything()
    )
    expect(db.markWorkerDispatchReady).not.toHaveBeenCalled()
  })

  it('is ready once the agent took the preamble within the wait', async () => {
    const { db, receipt } = settle('accepted')

    await expect(receipt).resolves.toMatchObject({ state: 'ready', turnStart: 'observed' })
    expect(db.markWorkerStartUnknown).not.toHaveBeenCalled()
  })
})
