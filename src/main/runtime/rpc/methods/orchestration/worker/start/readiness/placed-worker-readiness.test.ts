import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'
import type { WorkerEffect, WorkerSetupReceipt } from '../placement/worker-placement-topology'
import { handOverWhenReady } from './placed-worker-readiness'

afterEach(() => {
  vi.useRealTimers()
})

const BUDGET_MS = 60_000
const SETUP_LIMIT_MS = 2 * 60 * 60_000

/** A structured worker start behind a running wait-for-setup Setup whose exit the test decides. */
function structuredStart() {
  let exitSetup: (exitCode: number) => void = () => {}
  let loseSetup: (error: Error) => void = () => {}
  let setupWaits = 0
  const runtime = {
    waitForSetupTerminalCompletion: (_handle: string, signal?: AbortSignal) =>
      new Promise<{ exitCode: number | null }>((resolve, reject) => {
        setupWaits += 1
        exitSetup = (exitCode) => resolve({ exitCode })
        loseSetup = reject
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      }),
    readTerminal: () => Promise.reject(new Error('no screen'))
  }
  let stage = 'terminal_readying'
  const db = {
    recordWorkerStage: ({ stage: next }: { stage: string }) => {
      stage = next
    },
    getWorkerDispatch: () => ({ state: 'starting', stage })
  }
  const setup: WorkerSetupReceipt = {
    requested: 'run',
    effective: 'run',
    source: 'repo',
    hookFound: true,
    startupPolicy: 'wait-for-setup',
    state: 'running'
  }
  const effects: WorkerEffect[] = [
    { kind: 'setup', action: 'run', state: 'running', terminalId: 'term_setup' }
  ]
  const handOver = vi.fn(async (_deliveryDeadline?: number) => 'brief delivered')
  const fail = vi.fn(async (error: unknown) => ({
    failed: error instanceof Error ? error.message : String(error)
  }))
  const onHandedOver = vi.fn()
  const onSetupFailed = vi.fn()
  const start = handOverWhenReady({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the structured setup wait reads only the methods faked above.
    runtime: runtime as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a structured start reads no session field before hand-over.
    structuredSession: {} as never,
    workerChat: false,
    setupStage: {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wait records and reads only the stage faked above.
      db: db as unknown as OrchestrationDb,
      dispatchId: 'dispatch-1',
      worktreeId: 'worktree-1',
      terminalHandle: 'term_worker',
      setup,
      effects
    },
    readiness: { agent: 'claude', reusesTerminal: false },
    timeoutMs: BUDGET_MS,
    readinessDeadline: Date.now() + BUDGET_MS,
    launchedAt: Date.now(),
    receipt: {
      runId: 'run-1',
      taskId: 'task-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receipt only echoes these back.
      launch: {} as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the receipt only echoes these back.
      mode: {} as never
    },
    onSetupFailed,
    handOver,
    bindTerminal: () => {},
    onHandedOver,
    fail
  })
  return {
    start,
    exitSetup: (code: number) => exitSetup(code),
    loseSetup: (error: Error) => loseSetup(error),
    setupWaits: () => setupWaits,
    setup,
    handOver,
    fail,
    onHandedOver,
    onSetupFailed
  }
}

describe('a structured worker start behind wait-for-setup', () => {
  it('hands over at once when Setup succeeds within the budget', async () => {
    vi.useFakeTimers()
    const worker = structuredStart()
    await vi.advanceTimersByTimeAsync(1_000)
    worker.exitSetup(0)
    expect(await worker.start).toBe('brief delivered')
    expect(worker.setup.state).toBe('succeeded')
  })

  it('fails the start when Setup fails within the budget', async () => {
    vi.useFakeTimers()
    const worker = structuredStart()
    worker.exitSetup(1)
    await expect(worker.start).rejects.toThrow(
      'Setup did not finish before the structured worker started (exited).'
    )
    expect(worker.onSetupFailed).toHaveBeenCalled()
    expect(worker.handOver).not.toHaveBeenCalled()
  })

  it('keeps starting past the budget and hands over once Setup succeeds', async () => {
    vi.useFakeTimers()
    const worker = structuredStart()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(await worker.start).toMatchObject({
      state: 'starting',
      stage: 'awaiting_agent',
      nextCommands: expect.arrayContaining(['orca terminal read --terminal term_setup --screen'])
    })
    expect(await worker.start).not.toHaveProperty('readyBy')
    expect(worker.handOver).not.toHaveBeenCalled()

    // Past the old 10 min limit counted from launch: Setup now gets 2 h.
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    worker.exitSetup(0)
    const setupEndedAt = Date.now()
    await vi.waitFor(() => expect(worker.onHandedOver).toHaveBeenCalledWith('brief delivered'))
    // A fresh delivery budget from Setup's end (waitFor's own polling moves the fake clock a little).
    const deliveryDeadline = worker.handOver.mock.calls[0]?.[0] ?? 0
    expect(deliveryDeadline - setupEndedAt).toBeGreaterThanOrEqual(BUDGET_MS)
    expect(deliveryDeadline - setupEndedAt).toBeLessThan(BUDGET_MS + 1_000)
    expect(worker.setup.state).toBe('succeeded')
    expect(worker.fail).not.toHaveBeenCalled()
    // One Setup wait spans the budget and the background: the setup terminal is never looked up again.
    expect(worker.setupWaits()).toBe(1)
  })

  it('fails the start when Setup fails after the budget', async () => {
    vi.useFakeTimers()
    const worker = structuredStart()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(await worker.start).toMatchObject({ state: 'starting' })

    worker.exitSetup(1)
    await vi.waitFor(() =>
      expect(worker.onHandedOver).toHaveBeenCalledWith({
        failed: 'Setup did not finish before the structured worker started (exited).'
      })
    )
    expect(worker.setup.state).toBe('failed')
    expect(worker.onSetupFailed).toHaveBeenCalled()
    expect(worker.handOver).not.toHaveBeenCalled()
  })

  it('fails the start when Setup is still running 2 h after launch', async () => {
    vi.useFakeTimers()
    const worker = structuredStart()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(await worker.start).toMatchObject({ state: 'starting' })

    await vi.advanceTimersByTimeAsync(SETUP_LIMIT_MS - BUDGET_MS - 1)
    expect(worker.onHandedOver).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await vi.waitFor(() =>
      expect(worker.onHandedOver).toHaveBeenCalledWith({
        failed: 'Setup did not finish before the structured worker started (timeout).'
      })
    )
    expect(worker.setup.state).toBe('running')
    expect(worker.handOver).not.toHaveBeenCalled()
  })

  it('fails the start, sending nothing, when Orca loses sight of Setup within the budget', async () => {
    vi.useFakeTimers()
    const worker = structuredStart()
    worker.loseSetup(new Error('terminal_handle_stale'))
    await expect(worker.start).rejects.toThrow(
      'Orca lost sight of Setup (terminal_handle_stale), so it never sent the brief; Setup may still be running.'
    )
    expect(worker.handOver).not.toHaveBeenCalled()
  })

  it('fails the start, sending nothing, when Orca loses sight of Setup after the budget', async () => {
    vi.useFakeTimers()
    const worker = structuredStart()
    await vi.advanceTimersByTimeAsync(BUDGET_MS)
    expect(await worker.start).toMatchObject({ state: 'starting' })

    worker.loseSetup(new Error('terminal_handle_stale'))
    await vi.waitFor(() =>
      expect(worker.onHandedOver).toHaveBeenCalledWith({
        failed:
          'Orca lost sight of Setup (terminal_handle_stale), so it never sent the brief; Setup may still be running.'
      })
    )
    expect(worker.handOver).not.toHaveBeenCalled()
  })
})
