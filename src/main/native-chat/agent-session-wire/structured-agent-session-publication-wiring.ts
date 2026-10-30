import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionClientDelivery } from './structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationDelivery } from './structured-agent-session-host-delivery'
import {
  deferredStructuredAgentSessionLogger,
  type StructuredAgentSessionLogger
} from './structured-agent-session-logger'

/** Resolve collaborators only when called: host fields are wired before constructor initialization. */
export function createStructuredAgentSessionPublicationWiring(input: {
  client: () => StructuredAgentSessionClientDelivery
  delivery: () => StructuredAgentSessionConversationDelivery
  opened: (id: string) => void
  logger: () => StructuredAgentSessionLogger
  now: () => number
}): StructuredAgentSessionConversations {
  return new StructuredAgentSessionConversations({
    observe: (id, journal, rows) => input.client().requestFailures.observe(id, journal, rows),
    forget: (id) => input.client().requestFailures.forget(id),
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
