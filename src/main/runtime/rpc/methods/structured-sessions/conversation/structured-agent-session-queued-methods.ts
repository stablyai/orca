// Do not gate queued-card actions on queued-messages.v2: hosts without it still publish unsent cards. Older pre-queue/edit hosts lack the methods.

import { defineMethod } from '../../../core'
import {
  requireStructuredSessionHost as requireSessionHost,
  requireStructuredCleanupHost,
  structuredCallerFor as callerFor
} from '../creation/structured-agent-session-gate'
import {
  QueuedMessageActionParams,
  QueuedMessagesResumeParams
} from '../../../../../../shared/rpc-contract/structured-agent-session-params'
import '../../../../../../shared/rpc-contract/structured-agent-session-continue-params'
import '../../../../../../shared/rpc-contract/structured-agent-session-rename-params'
import {
  QueuedMessageMoveParams,
  QueuedMessageUpdateParams,
  QueuedMessageEditHoldParams
} from '../../../../../../shared/rpc-contract/structured-agent-session-queued-edit-params'
import { readsQueuedImageCards } from '../attachments/structured-agent-session-queued-image-capability'

export const STRUCTURED_AGENT_SESSION_QUEUED_METHODS = [
  defineMethod({
    name: 'agentSession.queuedMessageUpdate',
    permission: 'workspace',
    params: QueuedMessageUpdateParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).queuedMessageUpdate(callerFor(ctx), {
        ...params,
        queuedImageCards: readsQueuedImageCards(ctx)
      })
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
    name: 'agentSession.queuedMessageMove',
    permission: 'workspace',
    params: QueuedMessageMoveParams,
    handler: async (params, ctx) =>
      requireSessionHost(ctx, params.envelope.sessionId).queuedMessageMove(callerFor(ctx), params)
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
