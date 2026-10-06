// `agentSession.subscribeTurnCompletions` — every structured turn that settles from now on.
//
// Separate from `agentSession.subscribeStatus` because it answers a different question. Status is
// state a late subscriber still needs, so that stream opens with a snapshot of every session. A
// completion is an edge that has already passed, so this one opens with nothing and replays
// nothing: a client that was away during a completion has missed it, by decision.

import { defineStreamingMethod } from '../core'
import { requireStructuredHost as requireHost } from './structured-agent-session-gate'
import { structuredAgentSessionTurnCompletionSubscriptionId } from './structured-agent-session-subscription-id'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'

export const STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS = [
  defineStreamingMethod({
    name: 'agentSession.subscribeTurnCompletions',
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
