import { forgetProviderRelayRunVerdict } from '../../../provider-relay/app-provider-relays'
import { observeNativeChatPromptSubmissions } from '../../../telemetry/native-chat-prompt-submissions'
import { StructuredAgentSessionConversations } from './structured-agent-session-conversations'
import type { StructuredAgentSessionHostDeps } from './structured-agent-session-host-types'
import type { StructuredAgentSessionClientDelivery } from '../publication/subscribers/structured-agent-session-client-delivery'
import type { StructuredAgentSessionConversationDelivery } from '../delivery/structured-agent-session-host-delivery'
import { deferredStructuredAgentSessionLogger } from './structured-agent-session-logger'

/** Resolve collaborators only when called: host fields are wired before constructor initialization. */
export function createStructuredAgentSessionPublicationWiring(input: {
  client: () => StructuredAgentSessionClientDelivery
  delivery: () => StructuredAgentSessionConversationDelivery
  opened: (id: string) => void
  workChanged?: (id: string) => void
  deps: () => StructuredAgentSessionHostDeps
  now: () => number
}): StructuredAgentSessionConversations {
  return new StructuredAgentSessionConversations({
    observe: (id, journal, rows) => {
      input.client().requestFailures.observe(id, journal, rows)
      input.deps().observeCommittedRows?.(id, journal, rows)
      observeNativeChatPromptSubmissions(journal, rows)
    },
    forget: (id) => {
      input.client().requestFailures.forget(id)
      // A closed chat's undecided run is asked again at its next open.
      forgetProviderRelayRunVerdict(id)
      input.delivery().closed(id)
    },
    deliver: (id, journal, inputChanged) => {
      input.client().subscribers.deliverFrames(id, journal, undefined, inputChanged)
      input.client().publishJournal(id, journal, true, inputChanged)
      if (inputChanged) {
        input.delivery().afterCommit(id, journal)
      }
    },
    deliverSettleEdge: (id, journal) => input.delivery().afterSettleEdge(id, journal),
    logger: deferredStructuredAgentSessionLogger(() => input.deps().logger),
    onOpened: input.opened,
    workChanged: input.workChanged,
    currentFence: (id) => {
      const lease = input.deps().store.getRecord(id)?.lease
      return lease?.claimStatus === 'live' &&
        !lease.unreconciled &&
        lease.handoffStage !== 'recovering'
        ? lease.runtimeFence
        : undefined
    },
    now: input.now
  })
}
