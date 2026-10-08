// The queued-message actions: Send-now and Delete on one card, and Resume on a
// paused queue. Not gated on agent-session.queued-messages.v1: a host without it
// still publishes the cards it kept unsent. A host older than the queue lacks them.

import { defineMethod } from '../core'
import {
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import {
  QueuedMessageActionParams,
  QueuedMessagesResumeParams
} from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_QUEUED_METHODS = [
  defineMethod({
    name: 'agentSession.queuedMessageSend',
    permission: 'workspace',
    params: QueuedMessageActionParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).queuedMessageSend(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.queuedMessageDelete',
    permission: 'workspace',
    params: QueuedMessageActionParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).queuedMessageDelete(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.queuedMessagesResume',
    permission: 'workspace',
    params: QueuedMessagesResumeParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).queuedMessagesResume(
        callerFor(ctx),
        params
      )
  })
]
