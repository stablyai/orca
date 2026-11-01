// Track exit recovery through teardown so callbacks cannot write after journal removal.
// Starts, option drops and requested-close ends use their own session lane to avoid waiting on another session's reacquisition.

import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

export function createStructuredAgentSessionLifecycleDelivery(input: {
  handle: (event: StructuredAgentSessionLifecycleEvent) => Promise<void> | undefined
  logger: StructuredAgentSessionLogger
  /** Exits the adapter has observed but not yet published. */
  drainObservedExits: () => Promise<void>
}): {
  deliver: (event: StructuredAgentSessionLifecycleEvent) => void
  /** Resolves once every observed exit has published and everything delivered has settled. */
  drain: () => Promise<void>
} {
  let recoveryChain = Promise.resolve()
  const settlingStarts = new Set<Promise<void>>()
  const settle = async (event: StructuredAgentSessionLifecycleEvent): Promise<void> => {
    try {
      await input.handle(event)
    } catch (error) {
      input.logger.warn(`delivering a provider ${event.type} event to the host failed`, {
        scope: event.type === 'ended' ? 'lifecycle-exit' : `lifecycle-${event.type}`,
        sessionId: event.sessionId,
        error
      })
    }
  }
  return {
    deliver: (event) => {
      if (event.type !== 'ended' || event.cause === 'requested-close') {
        // Queue immediately on this session's lane, independent of other sessions.
        const settling = settle(event)
        settlingStarts.add(settling)
        void settling.finally(() => settlingStarts.delete(settling))
        return
      }
      recoveryChain = recoveryChain.then(() => settle(event))
    },
    drain: async () => {
      // A recovery may synchronously trigger another exit while it is reacquiring, so observe
      // until nothing new arrives.
      for (;;) {
        await input.drainObservedExits()
        const observed = recoveryChain
        await observed
        if (settlingStarts.size > 0) {
          await Promise.all(settlingStarts)
          continue
        }
        if (observed === recoveryChain) {
          return
        }
      }
    }
  }
}
