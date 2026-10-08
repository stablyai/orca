// `agentSession.subscribeTurnCompletions` — every structured turn that settles from now on, and,
// for a client that asks with `includePrompts`, every approval or question newly put to the user.
//
// Separate from `agentSession.subscribeStatus` because it answers a different question. Status is
// state a late subscriber still needs, so that stream opens with a snapshot of every session. A
// completion is an edge that has already passed, so this one opens with nothing and replays
// nothing: a client that was away during a completion has missed it, by decision.

import { defineMethod, defineStreamingMethod } from '../core'
import {
  requireStructuredCapability,
  requireStructuredHost as requireHost
} from './structured-agent-session-gate'
import {
  AcknowledgeAttentionParams,
  SubscribeTurnCompletionsParams
} from './structured-agent-session-schemas'
import { structuredAgentSessionTurnCompletionSubscriptionId } from './structured-agent-session-subscription-id'
import { bindStructuredAgentSessionStream } from './structured-agent-session-status-stream'
import { clientReadsStructuredSessionAgent } from './structured-agent-session-policy'

export const STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS = [
  // Retire only deliveries whose journal cause the client's accepted read covered: the session and
  // its journal epoch already name them, so no host is installed to answer. True: the read applied.
  defineMethod({
    name: 'agentSession.acknowledgeAttention',
    params: AcknowledgeAttentionParams,
    handler: (params, ctx) => {
      requireStructuredCapability(ctx)
      ctx.runtime.retireStructuredAttention({
        sessionId: params.sessionId,
        observedCursor: params.observedCursor
      })
      return { acknowledged: true }
    }
  }),
  defineStreamingMethod({
    name: 'agentSession.subscribeTurnCompletions',
    params: SubscribeTurnCompletionsParams,
    handler: async (params, ctx, emit) => {
      const host = requireHost(ctx)
      const subscriptionId = structuredAgentSessionTurnCompletionSubscriptionId(ctx)
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      dispose = host.subscribeTurnCompletions({
        id: subscriptionId,
        // A client that cannot read an agent's rows is not told that agent's edges either.
        emit: (event) => {
          const sessionId =
            event.type === 'completion'
              ? event.completion.sessionId
              : event.type === 'prompt'
                ? event.prompt.sessionId
                : undefined
          if (
            sessionId === undefined ||
            clientReadsStructuredSessionAgent(ctx, host.sessionAgent(sessionId) ?? '')
          ) {
            emit(event)
          }
        },
        includePrompts: params.includePrompts === true
      })
      if (stream.isClosed()) {
        dispose()
      }
    }
  })
]
