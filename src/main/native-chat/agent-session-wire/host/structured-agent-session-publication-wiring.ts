import { observeNativeChatPromptSubmissions } from '../../../telemetry/native-chat-prompt-submissions'
import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationDelivery } from '../delivery/structured-agent-session-host-delivery'
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
  observeRows: () => StructuredAgentSessionHostDeps['observeCommittedRows']
}): StructuredAgentSessionConversations {
  return new StructuredAgentSessionConversations({
    observe: (id, journal, rows) => {
      input.client().requestFailures.observe(id, journal, rows)
      input.observeRows()?.(id, journal, rows)
      observeNativeChatPromptSubmissions(journal, rows)
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
