import { describe, expect, it, vi } from 'vitest'

import type { AgentStatusStoreFrame } from '../../../../shared/agent-status-store-replication'
import { AGENT_STATUS_STORE_REPLICA_CAPABILITY } from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { AGENT_STATUS_STORE_METHODS } from './agent-status-store'

const snapshot: AgentStatusStoreFrame = {
  type: 'snapshot',
  executionHostId: 'local',
  ownerEpoch: 'epoch-a',
  cursor: 0,
  complete: true,
  rows: []
}

function testRuntime(
  options: {
    subscribe?: (emit: (frame: AgentStatusStoreFrame) => void) => () => void
  } = {}
): OrcaRuntimeService {
  const publisher = {
    snapshot: () => snapshot,
    subscribe: options.subscribe ?? (() => () => {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The methods under test read only this explicitly modeled runtime seam.
  return { getAgentStatusStorePublisher: () => publisher } as OrcaRuntimeService
}

describe('agent status store RPC methods', () => {
  it('rejects snapshot reads from clients that did not negotiate the contract', () => {
    const method = AGENT_STATUS_STORE_METHODS[0]

    expect(() => method.handler(undefined, { runtime: testRuntime() })).toThrow(
      'agent_status_store_capability_required'
    )
  })

  it('requires a lifecycle signal for subscriptions', async () => {
    const method = AGENT_STATUS_STORE_METHODS[1]

    await expect(
      method.handler(
        undefined,
        {
          runtime: testRuntime(),
          clientCapabilities: [AGENT_STATUS_STORE_REPLICA_CAPABILITY]
        },
        vi.fn()
      )
    ).rejects.toThrow('agent_status_store_subscription_signal_required')
  })

  it('does not subscribe an already-aborted request', async () => {
    const subscribe = vi.fn(() => vi.fn())
    const controller = new AbortController()
    controller.abort()

    await AGENT_STATUS_STORE_METHODS[1].handler(
      undefined,
      {
        runtime: testRuntime({ subscribe }),
        clientCapabilities: [AGENT_STATUS_STORE_REPLICA_CAPABILITY],
        signal: controller.signal
      },
      vi.fn()
    )

    expect(subscribe).not.toHaveBeenCalled()
  })

  it('releases the exact subscription when its request aborts', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const controller = new AbortController()
    const running = AGENT_STATUS_STORE_METHODS[1].handler(
      undefined,
      {
        runtime: testRuntime({ subscribe }),
        clientCapabilities: [AGENT_STATUS_STORE_REPLICA_CAPABILITY],
        signal: controller.signal
      },
      vi.fn()
    )

    expect(subscribe).toHaveBeenCalledOnce()
    controller.abort()
    await running
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
