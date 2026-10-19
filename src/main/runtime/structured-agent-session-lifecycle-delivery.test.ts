import { describe, expect, it } from 'vitest'
import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createStructuredAgentSessionLifecycleDelivery } from './structured-agent-session-lifecycle-delivery'

function ended(
  sessionId: string,
  cause: 'unexpected-exit' | 'requested-close'
): StructuredAgentSessionLifecycleEvent {
  return {
    type: 'ended',
    sessionId,
    reason: 'exited',
    cause,
    fence: 1,
    acquisitionGeneration: 'generation-1'
  }
}

describe('provider exits reaching the host', () => {
  // A close the host asked for ends on its own session's lane; another chat's crash recovery,
  // which can run a whole reacquisition, must not hold it up.
  it('ends a requested close without waiting behind another chat in recovery', async () => {
    const handled: string[] = []
    let releaseRecovery = (): void => {}
    const recovery = new Promise<void>((resolve) => {
      releaseRecovery = resolve
    })
    const delivery = createStructuredAgentSessionLifecycleDelivery({
      handle: async (event) => {
        if (event.type === 'ended' && event.cause === 'unexpected-exit') {
          await recovery
        }
        handled.push(event.sessionId)
      },
      logger: recordingStructuredAgentSessionLogger().logger,
      drainObservedExits: async () => {}
    })

    delivery.deliver(ended('crashed', 'unexpected-exit'))
    delivery.deliver(ended('closed', 'requested-close'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(handled).toEqual(['closed'])
    releaseRecovery()
    await delivery.drain()
    expect(handled).toEqual(['closed', 'crashed'])
  })
})
