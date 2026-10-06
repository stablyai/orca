// The queued-message actions: Send-now and Delete on one card, and Resume on a
// paused queue. All gated on agent-session.queued-messages.v1; an older host
// lacks the methods entirely. And Retry of a message no agent ever took, which
// queues it again: gated on agent-session.retry-message.v1.

import { defineMethod } from '../core'
import {
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import {
  QueuedMessageActionParams,
  QueuedMessagesResumeParams,
  RetryMessageParams
} from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_QUEUED_METHODS = [
  defineMethod({
    name: 'agentSession.queuedMessageSend',
    params: QueuedMessageActionParams,
    handler: async (params, ctx) => requireHost(ctx).queuedMessageSend(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.queuedMessageDelete',
    params: QueuedMessageActionParams,
    handler: async (params, ctx) => requireHost(ctx).queuedMessageDelete(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.queuedMessagesResume',
    params: QueuedMessagesResumeParams,
    handler: async (params, ctx) => requireHost(ctx).queuedMessagesResume(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.retryMessage',
    params: RetryMessageParams,
    handler: async (params, ctx) => requireHost(ctx).retryMessage(callerFor(ctx), params)
  })
]
