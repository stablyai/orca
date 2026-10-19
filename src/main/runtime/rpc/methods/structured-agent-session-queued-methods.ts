// The queued-message actions: Send-now, Delete and in-place Edit on one card, and Resume on a
// paused queue. Not gated on agent-session.queued-messages.v1: a host without it still publishes
// the cards it kept unsent. A host older than the queue, or than edit-v1, lacks them.

import { defineMethod } from '../core'
import {
  requireStructuredSessionHost as requireSessionHost,
  requireStructuredCleanupHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import {
  QueuedMessageActionParams,
  QueuedMessageUpdateParams,
  QueuedMessageEditHoldParams,
  QueuedMessagesResumeParams
} from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_QUEUED_METHODS = [
  defineMethod({
    name: 'agentSession.queuedMessageUpdate',
    permission: 'workspace',
    params: QueuedMessageUpdateParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).queuedMessageUpdate(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.queuedMessageEditHold',
    permission: 'workspace',
    params: QueuedMessageEditHoldParams,
    handler: async (params, ctx) => {
      // Releasing a lease is cleanup: no admission condition may strand it until its deadline.
      const host =
        params.action === 'release'
          ? requireStructuredCleanupHost(ctx)
          : requireSessionHost(ctx, params.sessionId)
      return host.queuedMessageEditHold(callerFor(ctx), params)
    }
  }),
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
