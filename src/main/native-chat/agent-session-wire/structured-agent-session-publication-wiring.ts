import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionProviderRetry } from './structured-agent-session-provider-retry'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationDelivery } from './structured-agent-session-host-delivery'
import {
  deferredStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './structured-agent-session-logger'

/** Resolve collaborators only when called: host fields are wired before constructor initialization. */
export function createStructuredAgentSessionPublicationWiring(input: {
  retry: () => StructuredAgentSessionProviderRetry
  client: () => StructuredAgentSessionClientDelivery
  delivery: () => StructuredAgentSessionConversationDelivery
  opened: (id: string) => void
  logger: () => StructuredAgentSessionLogger
  now: () => number
}): StructuredAgentSessionConversations {
  return new StructuredAgentSessionConversations({
    observe: (id, journal, rows, applied) => {
      if (input.delivery()?.loop.isDisposed()) {
        return
      }
      input.retry().observe(id, journal, rows)
      input.client().requestFailures.observe(id, journal, rows, applied)
    },
    forget: (id, disposition) => {
      input.retry().retire(id, 'abandon')
      input.client().requestFailures.forget(id, disposition)
    },
    deliver: (id, journal) => {
      input.client().subscribers.publish(id, journal)
      input.delivery().afterCommit(id, journal)
    },
    deliverSettleEdge: (id, journal) => input.delivery().afterSettleEdge(id, journal),
    logger: deferredStructuredAgentSessionLogger(input.logger),
    onOpened: input.opened,
    now: input.now
  })
}
