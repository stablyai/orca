import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { inspectWorkerTerminal } from './worker-observation'

vi.mock('../../../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const DISPATCH_ID = 'ctx-worker'
const TERMINAL_HANDLE = 'term-worker'

/** A local worker whose terminal row carries main's verdict, with no register verdict yet. */
function harness(row: { connected: boolean; verdict?: 'live' | 'unverifiable' | 'exited' }) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspectWorkerTerminal calls only these runtime methods.
  const runtime = {
    showTerminal: vi.fn(async () => ({ handle: TERMINAL_HANDLE, ...row })),
    getTerminalPaneKey: vi.fn(() => 'tab-worker:leaf-worker'),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-worker:incarnation-1'),
    getTerminalLivenessVerdict: vi.fn(() => null),
    getOrchestrationDispatchAuthority: vi.fn(() => null)
  } as unknown as OrcaRuntimeService
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: inspectWorkerTerminal calls only these db methods.
  const db = {
    getWorkerDispatch: vi.fn(() => ({ agent_terminal_handle: TERMINAL_HANDLE })),
    getDispatchContextById: vi.fn(() => ({
      host_scope: JSON.stringify({ kind: 'local', hostId: 'local' })
    })),
    isDispatchProcessCurrent: vi.fn(() => true)
  } as unknown as OrchestrationDb
  return { runtime, db }
}

// Layout-owner build: the row's verdict, not `connected`, says whether the worker's terminal lives.
describe('inspectWorkerTerminal reads the row verdict (switch on)', () => {
  it('a disconnected row the host cannot verify is unverifiable, not exited', async () => {
    const { runtime, db } = harness({ connected: false, verdict: 'unverifiable' })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      status: 'unverifiable'
    })
  })

  it('a connected row whose terminal the host reports absent is exited', async () => {
    const { runtime, db } = harness({ connected: true, verdict: 'exited' })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      status: 'exited'
    })
  })

  it('a row from an older host, with no verdict, still reads connected', async () => {
    const { runtime, db } = harness({ connected: false })

    await expect(inspectWorkerTerminal(runtime, db, DISPATCH_ID)).resolves.toMatchObject({
      status: 'exited'
    })
  })
})
