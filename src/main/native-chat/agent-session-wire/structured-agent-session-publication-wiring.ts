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
    advanceStatusProjection: (journal, rows) =>
      input.client().advanceStatusProjection(journal, rows),
    observe: (id, journal, rows, replacement) => {
      const client = input.client()
      if (!replacement) {
        return client.requestFailures.observe(id, journal, rows)
      }
      return client.requestFailures
        .observeAsync(id, journal, rows)
        .finally(() => client.prepareReplacementStatus(id, journal))
    },
    forget: (id) => input.client().requestFailures.forget(id),
    deliver: (id, journal, inputChanged) => {
      input.client().subscribers.deliverFrames(id, journal)
      input.client().publishJournal(id, journal, true, inputChanged)
      input.delivery().afterCommit(id, journal)
    },
    deliverSettleEdge: (id, journal) => input.delivery().afterSettleEdge(id, journal),
    logger: deferredStructuredAgentSessionLogger(input.logger),
    onOpened: input.opened,
    now: input.now
  })
}
