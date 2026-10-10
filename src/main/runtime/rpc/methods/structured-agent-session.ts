// `agentSession.*` — the structured session RPC surface.
//
// Every method here is gated on the client advertising
// `agent-session.structured.v1`. A client that does not is told the surface does
// not exist rather than receiving the journal or mutation surface. Session-tab
// inventory may expose only a metadata placeholder for an incapable mobile client.

import {
  projectBackgroundTaskEvent,
  projectBackgroundTaskHistory
} from './structured-agent-session-background-task-capability'
import {
  projectTurnItemEvent,
  projectTurnItemHistory
} from './structured-agent-session-turn-item-capability'
import { defineMethod, defineStreamingMethod } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireInstalledStructuredHost as requireInstalledHost,
  requireStructuredCapability,
  requireStructuredCleanupHost,
  requireStructuredCreateSupportAdmission,
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import {
  handleStructuredAgentSessionCreate,
  attachClientSuppliedLocation
} from './structured-agent-session-create-handler'
import { STRUCTURED_AGENT_SESSION_HOLD_METHODS } from './structured-agent-session-hold'
import { STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS } from './structured-agent-session-prompt-response'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './structured-agent-session-reveal'
import { STRUCTURED_AGENT_SESSION_QUEUED_METHODS } from './structured-agent-session-queued-methods'
import { STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS } from './structured-agent-session-restart-resume'
import {
  bindStructuredAgentSessionStream,
  STRUCTURED_AGENT_SESSION_STATUS_METHODS
} from './structured-agent-session-status-stream'
import {
  structuredAgentSessionSubscriptionBase as subscriptionBaseFor,
  structuredAgentSessionSubscriptionId as subscriptionIdFor
} from './structured-agent-session-subscription-id'
import { STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS } from './structured-agent-session-turn-completion-stream'
import { STRUCTURED_AGENT_SESSION_THREAD_GOAL_METHODS } from './structured-agent-session-thread-goal'
import { STRUCTURED_AGENT_SESSION_CONVERSATION_OUTLINE_METHODS } from './structured-agent-session-conversation-outline'
import { STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS } from './structured-agent-session-options-read'
import {
  AttachParams,
  CancelParams,
  ConversationCommandParams,
  CreateParams,
  CreateSupportParams,
  HistoryParams,
  OptionsParams,
  RewindParams,
  SendParams,
  SubscribeParams,
  UnsubscribeParams
} from './structured-agent-session-schemas'
import { sendStructuredAgentSessionForClient } from './structured-agent-session-send-compatibility'

export const STRUCTURED_AGENT_SESSION_METHODS = [
  defineMethod({
    name: 'agentSession.rewind',
    permission: 'workspace',
    params: RewindParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx)
      return requireSessionHost(ctx, params.envelope.sessionId).rewind(callerFor(ctx), params)
    }
  }),
  defineMethod({
    name: 'agentSession.conversationCommand',
    permission: 'workspace',
    params: ConversationCommandParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx)
      const host = requireSessionHost(ctx, params.envelope.sessionId)
      await host.revealSession(params.envelope.sessionId)
      return host.conversationCommand(callerFor(ctx), { ...params, userSend: true })
    }
  }),
  defineMethod({
    name: 'agentSession.createSupport',
    permission: 'workspace',
    params: CreateSupportParams,
    handler: async (params, ctx) => {
      requireStructuredCreateSupportAdmission(ctx, params.agent)
      const support = await ctx.runtime.getStructuredAgentSessionCreateSupport(
        params.worktree,
        params.agent
      )
      // Optional: older clients ignore it, and a client seeds its picker with what create will use.
      const seedOptions = support.supported
        ? ctx.runtime.structuredAgentSessionLaunchSeedOptions(params.agent)
        : undefined
      return seedOptions ? { ...support, seedOptions } : support
    }
  }),
  defineMethod({
    name: 'agentSession.create',
    permission: 'workspace',
    params: CreateParams,
    handler: handleStructuredAgentSessionCreate
  }),
  defineMethod({
    name: 'agentSession.ensure',
    permission: 'workspace',
    params: AttachParams,
    handler: async (params, ctx) => attachClientSuppliedLocation(params, ctx)
  }),
  defineMethod({
    name: 'agentSession.send',
    permission: 'workspace',
    params: SendParams,
    handler: sendStructuredAgentSessionForClient
  }),
  defineMethod({
    name: 'agentSession.cancel',
    permission: 'workspace',
    params: CancelParams,
    handler: async (params, ctx) => requireStructuredCleanupHost(ctx).cancel(callerFor(ctx), params)
  }),
  ...STRUCTURED_AGENT_SESSION_QUEUED_METHODS,
  defineMethod({
    // Releasing a chat view, not ending a conversation: the record and journal stay on disk so the
    // same session can be attached again. Only the provider child and the in-memory entry go.
    name: 'agentSession.close',
    permission: 'workspace',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const host = requireStructuredCleanupHost(ctx)
      // Terminal-disposal closes use this RPC without the session-tabs retirement RPC.
      if (typeof host.setSessionTabVisibility === 'function') {
        await host.setSessionTabVisibility(params.sessionId, false)
      }
      // Clients call this only when the user closes this chat's tab or cancels its launch.
      await host.close(params.sessionId, 'user-close')
      return { ok: true as const }
    }
  }),
  ...STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS,
  defineMethod({
    name: 'agentSession.history',
    permission: 'workspace',
    params: HistoryParams,
    handler: async (params, ctx) => {
      const host = await requireInstalledHost(ctx, params.sessionId)
      return projectTurnItemHistory(
        projectBackgroundTaskHistory(await host.history(params), ctx),
        ctx,
        host.sessionAgent(params.sessionId)
      )
    }
  }),
  defineStreamingMethod({
    name: 'agentSession.subscribe',
    permission: 'workspace',
    params: SubscribeParams,
    handler: async (params, ctx, emit) => {
      const host = await requireInstalledHost(ctx, params.sessionId)
      const subscriptionId = subscriptionIdFor(ctx, params.sessionId)
      // A stream reads; it never keeps an agent alive or starts one.
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => dispose())
      if (stream.isClosed()) {
        return
      }
      // Resolves once the conversation is open and the opening snapshot (or the missed batch) is
      // emitted; a close that raced the open disposes what it bound.
      dispose = await host.subscribe({
        id: subscriptionId,
        sessionId: params.sessionId,
        emit: (event) =>
          emit(
            projectTurnItemEvent(
              projectBackgroundTaskEvent(event, ctx),
              ctx,
              host.sessionAgent(params.sessionId)
            )
          ),
        ...(params.cursor ? { cursor: params.cursor } : {})
      })
      if (stream.isClosed()) {
        dispose()
      }
    }
  }),
  defineMethod({
    name: 'agentSession.unsubscribe',
    permission: 'workspace',
    params: UnsubscribeParams,
    handler: async (params, ctx) => {
      requireStructuredCleanupHost(ctx)
      const base = subscriptionBaseFor(ctx, params.sessionId)
      if (params.subscriptionId) {
        ctx.runtime.cleanupSubscription(`${base}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      ctx.runtime.cleanupSubscription(base)
      ctx.runtime.cleanupSubscriptionsByPrefix(`${base}:`)
      return { unsubscribed: true }
    }
  }),
  ...STRUCTURED_AGENT_SESSION_HOLD_METHODS,
  ...STRUCTURED_AGENT_SESSION_REVEAL_METHODS,
  ...STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS,
  ...STRUCTURED_AGENT_SESSION_STATUS_METHODS,
  ...STRUCTURED_AGENT_SESSION_TURN_COMPLETION_METHODS,
  ...STRUCTURED_AGENT_SESSION_THREAD_GOAL_METHODS,
  ...STRUCTURED_AGENT_SESSION_CONVERSATION_OUTLINE_METHODS,
  ...STRUCTURED_AGENT_SESSION_OPTIONS_READ_METHODS
]
