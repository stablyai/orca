import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import type { OrchestrationDb } from './db'
import type { DispatchContextRow } from './types'
import { reconcileUnsupervisedDispatchesOnRestart } from './orchestration-unsupervised-dispatch-recovery'

const DISPATCH_ID = 'ctx-injected'
const TERMINAL_HANDLE = 'term_injected'

function unsupervisedDispatch(): DispatchContextRow {
  return {
    id: DISPATCH_ID,
    assignee_handle: TERMINAL_HANDLE,
    host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
  } as unknown as DispatchContextRow
}

function createHarness(showTerminal: () => Promise<{ handle: string; connected: boolean } | null>) {
  const runtime = {
    showTerminal: vi.fn(showTerminal),
    getTerminalPaneKey: vi.fn(() => 'tab_injected:leaf'),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-injected:1'),
    getTerminalLivenessVerdict: vi.fn(() => null),
    getOrchestrationDispatchAuthority: vi.fn(() => null)
  } as unknown as OrcaRuntimeService
  const reconcileMissingWorkerTerminal = vi.fn()
  const db = {
    listUnsupervisedActiveDispatches: vi.fn(() => [unsupervisedDispatch()]),
    getWorkerDispatch: vi.fn(() => undefined),
    getDispatchContextById: vi.fn(() => unsupervisedDispatch()),
    isDispatchProcessCurrent: vi.fn(() => true),
    reconcileMissingWorkerTerminal
  } as unknown as OrchestrationDb
  return { runtime, db, reconcileMissingWorkerTerminal }
}

// Residual M: an injected dispatch left pending/dispatched with a live dcap must be settled
// (or left alone), never silently skipped, when the sweep runs headless after a restart.
describe('reconcileUnsupervisedDispatchesOnRestart (residual M)', () => {
  it('fails the dispatch, unknown, when the terminal cannot be found at all', async () => {
    const { runtime, db, reconcileMissingWorkerTerminal } = createHarness(async () => null)

    const result = await reconcileUnsupervisedDispatchesOnRestart(runtime, db)

    expect(result.failedDispatchIds).toEqual([DISPATCH_ID])
    expect(reconcileMissingWorkerTerminal).toHaveBeenCalledWith(
      DISPATCH_ID,
      expect.stringContaining('no longer live')
    )
  })

  it('leaves a live terminal untouched', async () => {
    const { runtime, db, reconcileMissingWorkerTerminal } = createHarness(async () => ({
      handle: TERMINAL_HANDLE,
      connected: true
    }))

    const result = await reconcileUnsupervisedDispatchesOnRestart(runtime, db)

    expect(result.failedDispatchIds).toEqual([])
    expect(reconcileMissingWorkerTerminal).not.toHaveBeenCalled()
  })

  it('never treats loss of contact (unverifiable) as gone', async () => {
    const { runtime, db, reconcileMissingWorkerTerminal } = createHarness(async () => ({
      handle: TERMINAL_HANDLE,
      connected: false
    }))
    ;(db.getDispatchContextById as ReturnType<typeof vi.fn>).mockReturnValue({
      ...unsupervisedDispatch(),
      host_scope: JSON.stringify({ kind: 'ssh', targetId: 'ssh-1' })
    })

    const result = await reconcileUnsupervisedDispatchesOnRestart(runtime, db)

    expect(result.failedDispatchIds).toEqual([])
    expect(reconcileMissingWorkerTerminal).not.toHaveBeenCalled()
  })
})
