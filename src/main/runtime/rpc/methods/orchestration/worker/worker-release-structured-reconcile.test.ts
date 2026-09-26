import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../../../../../native-chat/agent-session-wire/structured-agent-session-registry'
import { mintStructuredWorkerHandle } from '../../../../structured-worker-identity'

const { order } = vi.hoisted(() => {
  const order: string[] = []
  return { order }
})

vi.mock('./worker-observation', () => ({
  inspectWorkerTerminal: vi.fn(async () => {
    order.push('observe')
    return { status: 'identity_changed' }
  })
}))

const { completeWorkerTerminalRelease } = await import('./worker-release-completion')

afterEach(() => {
  order.length = 0
  setStructuredAgentSessionHost(null)
})

describe('structured worker release after a restart', () => {
  it('reads the worker only once the restart reconcile has settled its lease', async () => {
    const handle = mintStructuredWorkerHandle()
    const runtime = {
      ensureStructuredAgentSessionHost: vi.fn(async () => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release reads only the reconcile stubbed here.
        setStructuredAgentSessionHost({
          reconcileRestartLeases: async () => {
            // A reconcile that probes processes settles after a macrotask, not a microtask.
            await new Promise((resolve) => setTimeout(resolve, 0))
            order.push('reconcile')
          }
        } as never)
      })
    }
    const db = {
      getWorkerDispatch: () => ({ agent_terminal_handle: handle }),
      revertWorkerTerminalReleaseToRetained: () => ({ archive_source: null, archive_status: null }),
      recordWorkerTerminalRecoveryAttempt: vi.fn()
    }

    const receipt = await completeWorkerTerminalRelease({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this path reads only the runtime member stubbed above.
      runtime: runtime as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retained path reads only the dispatch rows stubbed above.
      db: db as never,
      dispatchId: 'dispatch-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the retained path reads only the id and handle.
      resource: { id: 'resource-1', terminal_handle: handle } as never,
      mode: 'recovery'
    })

    expect(receipt.state).toBe('retained')
    expect(order).toEqual(['reconcile', 'observe'])
  })
})
