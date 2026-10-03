import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../orchestration/preamble', () => ({ buildDispatchPreamble: () => 'preamble' }))
vi.mock('./worker-topology', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  monitorWorkerSetup: () => {}
}))
const teardown = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('./failed-worker-start-teardown', () => ({ tearDownFailedWorkerStart: teardown }))

const { deliverAndSettleWorkerStartReadiness } = await import('./worker-start-readiness-settlement')

/** `verdict`: what the host finally answers for a preamble it held. */
function settle(delivered: 'accepted' | undefined, verdict = new Promise<unknown>(() => {})) {
  let state = 'starting'
  const db = {
    getWorkerDispatch: () => ({ state }),
    markWorkerStartUnknown: vi.fn(() => {
      state = 'start_unknown'
      return { stage: 'turn_start_unobserved', residual_resources: '[]' }
    }),
    markWorkerDispatchReady: vi.fn(() => ({ state: 'ready', stage: 'ready' })),
    failWorkerStart: vi.fn(() => {
      state = 'failed'
    }),
    insertMessage: vi.fn((message: { to: string; type: string }) => ({
      to_handle: message.to,
      type: message.type
    }))
  }
  const notifyMessageArrived = vi.fn()
  const host = {
    deps: { store: { getRecord: () => ({ lease: { runtimeFence: 1 } }) } },
    send: async () => ({
      ok: true,
      value: { clientMessageId: 'c1', submission: { dispatchState: 'pending', reason: null } }
    }),
    // undefined: the worker's agent was still starting when the wait ran out.
    waitForSendSettlement: async (_session: string, _id: string, options?: { until?: string }) =>
      options?.until === 'verdict'
        ? verdict
        : delivered
          ? { value: { clientMessageId: 'c1', submission: { dispatchState: delivered } } }
          : undefined
  }
  const args = {
    runtime: {
      getNestedWorkerMaxDepth: () => 3,
      getTerminalOrchestrationCliCommand: () => 'orca',
      notifyMessageArrived
    },
    db,
    run: { id: 'run_1', legacy: 0 },
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
    effects: [],
    terminalRevealWarning: undefined,
    onStage: () => {}
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fakes implement exactly the runtime, db and host members this settlement reaches.
  const receipt = deliverAndSettleWorkerStartReadiness(args as never)
  return { db, receipt, notifyMessageArrived }
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

describe('a structured worker whose held preamble the host later rejects for good', () => {
  it('fails the start it left unknown, tears it down, and tells the Run once', async () => {
    teardown.mockClear()
    const rejected = Promise.withResolvers<unknown>()
    const { db, receipt, notifyMessageArrived } = settle(undefined, rejected.promise)
    await expect(receipt).resolves.toMatchObject({ state: 'outcome_unknown' })
    expect(db.failWorkerStart).not.toHaveBeenCalled()

    rejected.resolve({
      value: {
        clientMessageId: 'c1',
        submission: {
          dispatchState: 'rejected',
          reason: 'A Claude account switch is in progress. Try again after it finishes.',
          rejection: { kind: 'accountSwitchInProgress' }
        }
      }
    })

    await vi.waitFor(() => expect(db.failWorkerStart).toHaveBeenCalledOnce())
    expect(db.failWorkerStart).toHaveBeenCalledWith(
      'd1',
      'dispatch_input',
      'The dispatch preamble was not delivered (accountSwitchInProgress): A Claude account switch is in progress. Try again after it finishes.'
    )
    expect(teardown).toHaveBeenCalledWith(expect.objectContaining({ dispatchId: 'd1' }))
    expect(db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'run:run_1', type: 'escalation', runId: 'run_1' })
    )
    expect(notifyMessageArrived).toHaveBeenCalledWith('run:run_1', 'escalation')
  })

  it('does nothing when it lands, or when the worker moved on first', async () => {
    teardown.mockClear()
    const landed = settle(
      undefined,
      Promise.resolve({ value: { submission: { dispatchState: 'accepted' } } })
    )
    await landed.receipt
    const reported = Promise.withResolvers<unknown>()
    const movedOn = settle(undefined, reported.promise)
    await movedOn.receipt
    movedOn.db.markWorkerDispatchReady()
    // The worker reported before the verdict: it is no longer a start to settle.
    movedOn.db.getWorkerDispatch = () => ({ state: 'ready' })
    reported.resolve({ value: { submission: { dispatchState: 'rejected', reason: 'x' } } })
    await new Promise((resolve) => setImmediate(resolve))

    expect(landed.db.failWorkerStart).not.toHaveBeenCalled()
    expect(movedOn.db.failWorkerStart).not.toHaveBeenCalled()
    expect(teardown).not.toHaveBeenCalled()
  })
})
