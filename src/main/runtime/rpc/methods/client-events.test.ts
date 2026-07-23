import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../orca-runtime'

vi.mock('../../../ipc/ssh', () => ({
  getRegisteredSshState: vi.fn(),
  listRegisteredSshTargets: vi.fn(() => [])
}))
vi.mock('../../public-ssh-state', () => ({ getPublicSshState: vi.fn() }))

import { CLIENT_EVENT_METHODS } from './client-events'

function subscribeMethod() {
  const method = CLIENT_EVENT_METHODS.find(
    (candidate) => candidate.name === 'runtime.clientEvents.subscribe'
  )
  if (!method || !('stream' in method)) {
    throw new Error('Missing runtime.clientEvents.subscribe')
  }
  return method
}

describe('runtime client event snapshots', () => {
  it('includes pending decision attention so reconnects recover missed changes', async () => {
    let cleanup: (() => void) | undefined
    const runtime = {
      onClientEvent: () => vi.fn(),
      registerSubscriptionCleanup: (_id: string, nextCleanup: () => void) => {
        cleanup = nextCleanup
      },
      getTerminalSleepClientEventSnapshot: () => [],
      getOrchestrationDb: () => ({ countGates: () => 1 })
    } as unknown as OrcaRuntimeService
    const emit = vi.fn()

    const handling = subscribeMethod().handler(undefined, { runtime, connectionId: 'conn-1' }, emit)
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'ready',
          snapshot: expect.objectContaining({ pendingDecisionGates: true })
        })
      )
    )
    cleanup?.()
    await handling
  })
})
