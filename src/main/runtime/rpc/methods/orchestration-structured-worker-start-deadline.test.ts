// A structured worker's setup gate and its preamble's wait for the agent share one deadline: the
// caller's timeout. Waiting the full timeout again after a slow setup outlasts the client's limit.

import { afterEach, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'

const preambleBudgets: (number | undefined)[] = []

vi.mock('./orchestration-structured-worker-session', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendStructuredWorkerPreamble: async (args: { budgetMs?: number }) => {
    preambleBudgets.push(args.budgetMs)
    return 'accepted'
  }
}))
vi.mock('./orchestration/worker/worker-start-agent-placement', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  placeWorkerAgent: async (args: { mode: unknown; effects: unknown[] }) => {
    // The setup a created worktree runs, with the repo's wait-for-setup policy.
    args.effects.splice(0, args.effects.length, {
      kind: 'setup',
      action: 'started',
      terminalId: 'setup_1'
    })
    return {
      mode: args.mode,
      worktree: { id: 'wt_1' },
      terminalHandle: 'structured_worker_1',
      structuredSession: { host: {}, identity: { sessionId: 's1', handle: 'structured_worker_1' } },
      setupReceipt: { startupPolicy: 'wait-for-setup', state: 'running' }
    }
  }
}))
vi.mock('./orchestration/worker/worker-start-validation', () => ({
  prepareLocalWorkerStart: () => ({
    agent: 'claude',
    launch: { receipt: { requested: null, effective: null }, preferences: undefined }
  })
}))
vi.mock('./orchestration/worker/worker-setup-gate', () => ({
  persistGatedSetupSpawnFailure: () => false,
  persistWorkerReadinessStage: () => {},
  persistWorkerSetupWaitOutcome: () => {}
}))
vi.mock('./orchestration/worker/worker-topology', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  monitorWorkerSetup: () => {}
}))
vi.mock('./orchestration/runs/dispatch-creator', () => ({
  resolveDispatchCreator: () => ({ kind: 'terminal', handle: 'term_c' })
}))
vi.mock('../../orchestration/preamble', () => ({ buildDispatchPreamble: () => 'preamble' }))

const { startLocalWorker } = await import('./orchestration/worker/local-worker-start')

afterEach(() => {
  vi.useRealTimers()
  preambleBudgets.length = 0
})

it('leaves the preamble only what the setup gate did not use of the caller’s timeout', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const runtime = {
    showTerminal: async () => ({ worktreeId: 'wt_1' }),
    showManagedTerminalWorkspace: async () => ({ id: 'wt_1' }),
    getNestedWorkerMaxDepth: () => 3,
    getRuntimeId: () => 'epoch-1',
    getTerminalOrchestrationCliCommand: () => 'orca',
    getStructuredAgentSessionCreateSupport: async () => ({ supported: true }),
    getOrchestrationDispatchAuthority: () => ({ paneKey: 'pane', processIncarnation: 'inc' }),
    getTerminalProcessIncarnation: () => 'inc',
    // Setup takes 250 s of the 300 s timeout.
    waitForSetupTerminalCompletion: async () => {
      vi.setSystemTime(Date.now() + 250_000)
      return { exitCode: 0 }
    }
  }
  const db = {
    createStartingWorkerDispatch: () => ({
      dispatch: { id: 'd1', depth: 0 },
      task: { id: 't1', spec: 'do the thing' }
    }),
    recordWorkerStage: () => {},
    prepareStartingWorkerAuthority: () => {},
    getWorkerDispatch: () => ({ state: 'starting' }),
    markWorkerDispatchReady: () => ({ state: 'ready', stage: 'ready' })
  }

  const receipt = await startLocalWorker({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fields this start reads; the rest are optional.
    params: { from: 'term_c', timeoutMs: 300_000, agent: 'claude' } as never,
    mode: {
      mode: 'structured',
      preferred: 'structured',
      reason: 'user_default',
      detail: 'structured by default'
    } as const,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start path reaches only these runtime members.
    runtime: runtime as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start path reaches only these db members.
    db: db as unknown as OrchestrationDb,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the run id is read.
    run: { id: 'run_1' } as never,
    coordinator: null
  })

  expect(receipt).toMatchObject({ state: 'ready', timeoutMs: 300_000 })
  expect(preambleBudgets).toEqual([50_000])
})
