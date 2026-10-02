// How provider lifecycle events reach the host, and how teardown knows every one has landed.
//
// Exit recovery runs on one chain so teardown can drain it: exit callbacks arrive from child
// process tasks, and a fire-and-forget one could otherwise append after the host flushed and
// removed its journal directory. That chain orders nothing across sessions, and a recovery on it
// can run a whole reacquisition, so `started` and `end-unproven` stay off it: each takes only its
// own session's serialized step, and is tracked here so the same drain still waits for it.

import type { StructuredAgentSessionLifecycleEvent } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

const LOG_SCOPES = {
  started: 'lifecycle-started',
  ended: 'lifecycle-exit',
  'end-unproven': 'lifecycle-end-unproven'
} as const satisfies Record<StructuredAgentSessionLifecycleEvent['type'], string>

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
  const settlingOffChain = new Set<Promise<void>>()
  const settle = async (event: StructuredAgentSessionLifecycleEvent): Promise<void> => {
    try {
      await input.handle(event)
    } catch (error) {
      input.logger.warn(`delivering a provider ${event.type} event to the host failed`, {
        scope: LOG_SCOPES[event.type],
        sessionId: event.sessionId,
        error
      })
    }
  }
  return {
    deliver: (event) => {
      if (event.type !== 'ended') {
        // Called now, so the step is queued on its session ahead of any later exit of that child.
        const settling = settle(event)
        settlingOffChain.add(settling)
        void settling.finally(() => settlingOffChain.delete(settling))
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
        if (settlingOffChain.size > 0) {
          await Promise.all(settlingOffChain)
          continue
        }
        if (observed === recoveryChain) {
          return
        }
      }
    }
  }
}
