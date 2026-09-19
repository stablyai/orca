// `agentSession.subscribeTurnCompletion` — root turns settling, so a client can raise attention
// for a chat it is not showing.
//
// Separate from the status stream because a status summary carries no turn identity and no
// provider verdict, and a completion must not be inferred from a status transition. Like the
// status stream it is per connection rather than per session, and unlike it the stream opens with
// nothing: recovery is live-only by decision, so a completion that happened while this client was
// away is dropped rather than replayed.

import { defineStreamingMethod } from '../core'
import { requireStructuredHost as requireHost } from './structured-agent-session-gate'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { structuredAgentSessionTurnCompletionSubscriptionId } from './structured-agent-session-subscription-id'

export const STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS = [
  defineStreamingMethod({
    name: 'agentSession.subscribeTurnCompletion',
    params: null,
    handler: async (_params, ctx, emit) => {
      const host = requireHost(ctx)
      const subscriptionId = structuredAgentSessionTurnCompletionSubscriptionId(ctx)
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = host.subscribeTurnCompletions({ id: subscriptionId, emit })
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]
