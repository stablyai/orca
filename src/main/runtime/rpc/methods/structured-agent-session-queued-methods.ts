// The queued-message actions: Send-now and Delete on one card, and Resume on a
// paused queue. Not gated on agent-session.queued-messages.v1: a host without it
// still publishes the cards it kept unsent. A host older than the queue lacks them.

import { defineMethod } from '../core'
import {
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor,
  requireInstalledStructuredHost
} from './structured-agent-session-gate'
import {
  QueuedMessageActionParams,
  QueuedMessagesResumeParams,
  QueuedMessagesPageParams,
  QueuedMessageReadParams
} from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_QUEUED_METHODS = [
  defineMethod({
    name: 'agentSession.queuedMessagesPage',
    permission: 'workspace',
    params: QueuedMessagesPageParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx, params.sessionId)).queuedMessagesPage(params, {
        id: ctx.requestId ?? '',
        runtimeId: ctx.runtime.getRuntimeId()
      })
  }),
  defineMethod({
    name: 'agentSession.queuedMessageRead',
    permission: 'workspace',
    params: QueuedMessageReadParams,
    handler: async (params, ctx) =>
      (await requireInstalledStructuredHost(ctx, params.sessionId)).queuedMessageRead(params, {
        id: ctx.requestId ?? '',
        runtimeId: ctx.runtime.getRuntimeId()
      })
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
