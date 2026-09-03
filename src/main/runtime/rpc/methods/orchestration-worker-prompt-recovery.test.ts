import { describe, expect, it, vi } from 'vitest'
import { finishReadyWorkerStart } from './orchestration-worker-prompt-recovery'
import type { WorkerEffect, WorkerSetupReceipt } from './orchestration-worker-topology'

describe('recovered worker prompt finalization', () => {
  it('preserves reveal warnings and starts the same post-ready setup monitor', () => {
    const waitForSetupTerminalCompletion = vi.fn(() => new Promise(() => undefined))
    const effects: WorkerEffect[] = [
      { kind: 'terminal', role: 'setup', id: 'term_setup' },
      { kind: 'setup', state: 'running' }
    ]
    const setup: WorkerSetupReceipt = {
      requested: 'run',
      effective: 'run',
      source: 'orchestration_default',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
    }

    const receipt = finishReadyWorkerStart({
      runtime: { waitForSetupTerminalCompletion } as never,
      db: {} as never,
      runId: 'run_1',
      taskId: 'task_1',
      dispatchId: 'dispatch_1',
      worker: { state: 'ready', stage: 'worker_running' },
      setup,
      launch: { requested: {}, effective: {} },
      timeoutMs: 1_000,
      effects,
      warning: 'terminal was created in the background'
    })

    expect(receipt).toMatchObject({
      state: 'ready',
      stage: 'worker_running',
      warning: 'terminal was created in the background'
    })
    expect(waitForSetupTerminalCompletion).toHaveBeenCalledWith('term_setup')
  })
})
