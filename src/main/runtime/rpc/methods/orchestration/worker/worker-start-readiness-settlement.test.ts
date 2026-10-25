import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../orchestration/preamble', () => ({
  buildDispatchPreamble: () => 'preamble',
  dispatchPreambleSendOptions: (requestId: string) => ({ inputKind: 'driving', requestId })
}))
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
    devMode: undefined,
    requestId: 'r1',
    agent: 'claude',
    setupReceipt: {},
    launchReceipt: {},
    mode: {},
    timeoutMs: 60_000,
    readinessDeadline: Date.now() + 60_000,
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

describe('a terminal worker whose preamble delivery waited out a held paste', () => {
  it("observes its turn start only for what is left of the client's grace", async () => {
    vi.useFakeTimers()
    try {
      const prompt = {
        requestId: 'r1',
        stages: ['input_accepted'],
        provider: 'codex',
        observation: 'supported',
        processIncarnation: 'p1',
        generation: 1,
        baselineWorkingSequence: 0
      }
      const observeTerminalAgentPrompt = vi.fn(async () => ({
        ...prompt,
        stages: ['input_accepted', 'turn_started']
      }))
      const runtime = {
        getNestedWorkerMaxDepth: () => 3,
        getTerminalOrchestrationCliCommand: () => 'orca',
        // A Windows Codex rescue held the writer for 40 s of the 50 s grace.
        sendTerminalAgentPrompt: async () => {
          vi.setSystemTime(Date.now() + 40_000)
          return { handle: 'term_w', accepted: true, bytesWritten: 9, prompt }
        },
        getTerminalPromptRequestBinding: () => ({ processIncarnation: 'p1', generation: 1 }),
        observeTerminalAgentPrompt
      }
      const db = {
        getWorkerDispatch: () => ({ state: 'starting' }),
        markWorkerDispatchReady: vi.fn(() => ({ state: 'ready', stage: 'ready' }))
      }
      const args = {
        runtime,
        db,
        run: { id: 'run_1' },
        task: { id: 't1', spec: 'do the thing' },
        dispatchId: 'd1',
        dispatchDepth: 0,
        structuredSession: undefined,
        terminalHandle: 'term_w',
        coordinatorHandle: 'term_c',
        devMode: undefined,
        requestId: 'r1',
        setupReceipt: {},
        launchReceipt: {},
        mode: {},
        timeoutMs: 60_000,
        readinessDeadline: Date.now() + 60_000,
        effects: [],
        terminalRevealWarning: undefined,
        onStage: () => {}
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement exactly the runtime and db members this terminal settlement reaches.
      const receipt = deliverAndSettleWorkerStartReadiness(args as never)

      await expect(receipt).resolves.toMatchObject({ turnStart: 'observed' })
      expect(observeTerminalAgentPrompt).toHaveBeenCalledWith('term_w', prompt, 10_000)
    } finally {
      vi.useRealTimers()
    }
  })
})
