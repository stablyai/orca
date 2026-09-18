import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import { inspectRemoteAttachment } from './federation-attachment-observation'

const DISPATCH_ID = 'ctx-remote'
const TERMINAL_HANDLE = 'term-remote'

// O4: the execution host's federation twin of inspectWorkerTerminal. `inspectRemoteAttachment`
// collapsed every showTerminal rejection to `missing` (the owner-proven-absence word that
// `orchestration.federationShow` ships to the Run home and that the recovery release path
// treats as "not rediscovered yet"), so a transport timeout, a stale local handle or an
// unclassified throw all read as the owner certifying the terminal gone. Only a resolved null,
// or a thrown failure whose own code/message is `terminal_gone`, is owner-proven absence; every
// other failure is loss of contact and must read `unverifiable` -- the same gate O1/O2 gave the
// local observer.
function createHarness(showTerminal: () => Promise<unknown>) {
  const runtime = {
    getOrchestrationDb: () => db,
    showTerminal,
    getTerminalPaneKey: vi.fn(() => 'tab-remote:leaf-remote'),
    getTerminalProcessIncarnation: vi.fn(() => 'pty-remote:incarnation-1'),
    getTerminalLivenessVerdict: vi.fn(() => null),
    getOrchestrationDispatchAuthority: vi.fn(() => undefined)
  } as unknown as OrcaRuntimeService
  const db = {
    getRemoteDispatchAttachment: vi.fn(() => ({
      dispatch_id: DISPATCH_ID,
      terminal_handle: TERMINAL_HANDLE
    })),
    isRemoteAttachmentProcessCurrent: vi.fn(() => true),
    getWorkerTerminalResourceByOwner: vi.fn(() => null)
  } as unknown as OrchestrationDb
  return { runtime, db }
}

describe('inspectRemoteAttachment showTerminal failure classification (O4)', () => {
  it('classifies a request timeout as unverifiable, not missing', async () => {
    const { runtime } = createHarness(() =>
      Promise.reject(Object.assign(new Error('deadline exceeded'), { code: 'request_timeout' }))
    )

    const observation = await inspectRemoteAttachment(runtime, DISPATCH_ID)

    expect(observation.status).toBe('unverifiable')
    expect(observation).toMatchObject({ terminal: null, exact: false, reason: 'timeout' })
  })

  it('treats terminal_handle_stale as unverifiable, not owner-proven missing', async () => {
    const { runtime } = createHarness(() =>
      Promise.reject(
        Object.assign(new Error('terminal_handle_stale'), { code: 'terminal_handle_stale' })
      )
    )

    const observation = await inspectRemoteAttachment(runtime, DISPATCH_ID)

    expect(observation.status).toBe('unverifiable')
    expect(observation.reason).toBe('terminal_handle_stale')
  })

  it('classifies an unclassified showTerminal failure as unverifiable, not missing', async () => {
    const { runtime } = createHarness(() => Promise.reject(new Error('boom')))

    const observation = await inspectRemoteAttachment(runtime, DISPATCH_ID)

    expect(observation.status).toBe('unverifiable')
    expect(observation.reason).toBe('unclassified_inspection_failure')
  })

  it('keeps missing when the owner proves the terminal is gone', async () => {
    const { runtime } = createHarness(() =>
      Promise.reject(Object.assign(new Error('terminal_gone'), { code: 'terminal_gone' }))
    )

    await expect(inspectRemoteAttachment(runtime, DISPATCH_ID)).resolves.toMatchObject({
      terminal: null,
      exact: false,
      status: 'missing'
    })
  })

  it('keeps missing when showTerminal resolves null', async () => {
    const { runtime } = createHarness(async () => null)

    await expect(inspectRemoteAttachment(runtime, DISPATCH_ID)).resolves.toMatchObject({
      terminal: null,
      exact: false,
      status: 'missing'
    })
  })
})
