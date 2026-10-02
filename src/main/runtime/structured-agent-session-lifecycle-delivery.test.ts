import { expect, it, vi } from 'vitest'
import { recordingStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger-test-support'
import { createStructuredAgentSessionLifecycleDelivery } from './structured-agent-session-lifecycle-delivery'

it("keeps an unproven end off the exit chain, so its wait on its own session holds up no other session's exit, and drain still waits for it", async () => {
  const sessionLane = Promise.withResolvers<void>()
  const handled: string[] = []
  const delivery = createStructuredAgentSessionLifecycleDelivery({
    handle: async (event) => {
      if (event.type === 'end-unproven') {
        await sessionLane.promise
      }
      handled.push(`${event.type}:${event.sessionId}`)
    },
    logger: recordingStructuredAgentSessionLogger().logger,
    drainObservedExits: async () => {}
  })

  delivery.deliver({
    type: 'end-unproven',
    sessionId: 'session-a',
    reason: 'journal fault',
    fence: 1,
    acquisitionGeneration: 'a-1'
  })
  delivery.deliver({
    type: 'ended',
    sessionId: 'session-b',
    reason: 'exited',
    cause: 'unexpected-exit',
    fence: 1,
    acquisitionGeneration: 'b-1'
  })
  await vi.waitFor(() => expect(handled).toEqual(['ended:session-b']))

  let drained = false
  const draining = delivery.drain().then(() => {
    drained = true
  })
  await new Promise((resolve) => setImmediate(resolve))
  expect(drained).toBe(false)

  sessionLane.resolve()
  await draining
  expect(handled).toEqual(['ended:session-b', 'end-unproven:session-a'])
})
