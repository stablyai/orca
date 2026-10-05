import { describe, expect, it, vi } from 'vitest'
import { awaitStructuredWorkerSetupGate } from './worker-start-structured-setup-gate'
import type { WorkerEffect, WorkerSetupReceipt } from './worker-topology'

const RUNNING_WAIT_FOR_SETUP: WorkerSetupReceipt = {
  requested: 'run',
  effective: 'run',
  source: 'repo',
  hookFound: true,
  startupPolicy: 'wait-for-setup',
  state: 'running'
}

function setupEffects(): WorkerEffect[] {
  return [{ kind: 'setup', action: 'spawned', terminalId: 'term_setup' }]
}

// Why this file and not `worker-start-structured-setup-gate.test.ts`: that name is taken by the
// open setup-observer-timeout change, and two branches adding the same new path collide on merge.
describe('awaitStructuredWorkerSetupGate verdicts', () => {
  it.each([
    { exitCode: 0, satisfied: true },
    { exitCode: 1, satisfied: false },
    // Why null is not a pass: the observed setup shell exited without ever printing its completion
    // marker, so nothing proved the setup ran (#18059).
    { exitCode: null, satisfied: false }
  ])(
    'maps a setup completion of $exitCode to satisfied=$satisfied',
    async ({ exitCode, satisfied }) => {
      const effects = setupEffects()

      const gate = await awaitStructuredWorkerSetupGate({
        runtime: { waitForSetupTerminalCompletion: vi.fn().mockResolvedValue({ exitCode }) },
        setup: RUNNING_WAIT_FOR_SETUP,
        effects,
        timeoutMs: 1_000
      })

      expect(gate).toEqual({ satisfied, status: 'exited' })
      expect(effects).toHaveLength(1)
    }
  )
})
