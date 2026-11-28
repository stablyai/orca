import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../../../orchestration/db/orchestration-db'
import { monitorWorkerSetup } from './worker-placement-topology'

async function finishSetup(exitCode: number) {
  const runtime = {
    waitForSetupTerminalCompletion: vi.fn(async () => ({ exitCode })),
    notifyMessageArrived: vi.fn()
  }
  const db = {
    updateWorkerSetupEvidence: vi.fn(() => ({ changed: true })),
    getDispatchContextById: () => null,
    insertMessage: vi.fn((message: { to: string; type: string }) => ({
      to_handle: message.to,
      type: message.type
    }))
  }
  monitorWorkerSetup({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the monitor reads only the methods faked above.
    runtime: runtime as unknown as OrcaRuntimeService,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the monitor reads only the methods faked above.
    db: db as unknown as OrchestrationDb,
    runId: 'run-1',
    dispatchId: 'ctx_1',
    setupReceipt: {
      requested: 'run',
      effective: 'run',
      source: 'repo',
      hookFound: true,
      startupPolicy: 'start-immediately',
      state: 'running'
    },
    effects: [
      { kind: 'setup', action: 'run', state: 'running', terminalId: 'term_setup' },
      { kind: 'terminal', role: 'setup', id: 'term_setup' }
    ]
  })
  await vi.waitFor(() => expect(db.updateWorkerSetupEvidence).toHaveBeenCalled())
  await Promise.resolve()
  return { runtime, db }
}

describe('monitorWorkerSetup', () => {
  it('records a successful setup without mailing or waking the coordinator', async () => {
    const { runtime, db } = await finishSetup(0)
    expect(db.updateWorkerSetupEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'ctx_1', setupState: 'succeeded' })
    )
    expect(db.insertMessage).not.toHaveBeenCalled()
    expect(runtime.notifyMessageArrived).not.toHaveBeenCalled()
  })

  it('mails and wakes the coordinator when setup fails', async () => {
    const { runtime, db } = await finishSetup(1)
    expect(db.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'run:run-1',
        subject: 'Setup failed for worker ctx_1',
        priority: 'high'
      })
    )
    expect(runtime.notifyMessageArrived).toHaveBeenCalledWith('run:run-1', 'status')
  })
})
