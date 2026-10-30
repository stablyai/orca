// The mobile attention feed wired onto a freshly installed structured host.
//
// Split from the host install because the subscription's shape is the delivery's own business:
// which events it forwards, and what status it reads alongside them. The runtime only says whether
// the host has a phone to reach at all.

import type { StructuredAttentionMobileDelivery } from './structured-agent-session-mobile-attention'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'

/** Subscribes the host's turn completions to phone delivery. Lives exactly as long as the host:
 *  teardown drops the host and its subscribers together. */
export function installStructuredAgentSessionAttentionDelivery(args: {
  host: StructuredAgentSessionHost
  delivery?: StructuredAttentionMobileDelivery
}): void {
  const { host, delivery } = args
  if (!delivery) {
    return
  }
  host.subscribeTurnCompletions({
    id: 'host-attention-delivery',
    includePrompts: true,
    emit: (event) => {
      if (event.type === 'end') {
        return
      }
      const sessionId =
        event.type === 'prompt' ? event.prompt.sessionId : event.completion.sessionId
      delivery.deliver(event, host.readStatusSummary(sessionId))
    },
    onState: delivery.reconcile
  })
}
