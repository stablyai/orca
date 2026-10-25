// Emit future turn completions and opted-in prompts only; unlike status snapshots, missed edges never replay.

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
  // Retire only prompt deliveries covered by the accepted read's session/epoch, without installing the host.
  defineMethod({
    name: 'agentSession.acknowledgeAttention',
    permission: 'workspace',
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
    permission: 'workspace',
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
