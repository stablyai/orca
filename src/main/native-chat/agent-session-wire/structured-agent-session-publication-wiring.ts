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
      return client.observeReplacement(id, journal, () =>
        client.requestFailures.observeAsync(id, journal, rows)
      )
    },
    forget: (id) => input.client().requestFailures.forget(id),
    deliver: (id, journal, inputChanged, replacement) => {
      if (replacement) {
        return (async () => {
          try {
            await input.client().subscribers.deliverReplacement(id, journal)
          } finally {
            try {
              await input.client().observeReplacement(id, journal, async () => {})
              input.client().publishJournal(id, journal, true, inputChanged, true)
            } finally {
              input.delivery().afterCommit(id, journal)
            }
          }
        })()
      }
      input.client().subscribers.deliverFrames(id, journal)

      input.client().publishJournal(id, journal, true, inputChanged, replacement)
      if (inputChanged !== false) {
        input.delivery().afterCommit(id, journal)
      }
      return undefined
    },
    afterReplacementProjection: (...args) => input.client().afterReplacementProjection(...args),
    deliverSettleEdge: (id, journal) => input.delivery().afterSettleEdge(id, journal),
    logger: deferredStructuredAgentSessionLogger(input.logger),
    onOpened: input.opened,
    now: input.now
  })
}
