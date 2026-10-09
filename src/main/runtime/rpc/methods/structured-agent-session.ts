// `agentSession.*` — the structured session RPC surface.
//
// Every method here is gated on the client advertising
// `agent-session.structured.v1`. A client that does not is told the surface does
// not exist rather than receiving the journal or mutation surface. Session-tab
// inventory may expose only a metadata placeholder for an incapable mobile client.

import { agentSessionRefusalError } from '../../../../shared/agent-session-wire-refusals'
import { agentSessionFingerprintConflict } from '../../../../shared/agent-session-mutation-envelope'
import type { z } from 'zod'
import {
  projectBackgroundTaskEvent,
  projectBackgroundTaskHistory
} from './structured-agent-session-background-task-capability'
import {
  projectTurnItemEvent,
  projectTurnItemHistory
} from './structured-agent-session-turn-item-capability'
import { defineMethod, defineStreamingMethod, type RpcContext } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireInstalledStructuredHost as requireInstalledHost,
  requireStructuredCapability,
  requireStructuredAgentAudience,
  requireStructuredCleanupHost,
  requireStructuredCreateSupportAdmission,
  requireStructuredHost as requireHost,
  requireStructuredSessionHost as requireSessionHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree,
  structuredAgentSessionCreateIntentFingerprint
} from './structured-agent-session-create'
import { STRUCTURED_AGENT_SESSION_HOLD_METHODS } from './structured-agent-session-hold'
import { STRUCTURED_AGENT_SESSION_PROMPT_RESPONSE_METHODS } from './structured-agent-session-prompt-response'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './structured-agent-session-reveal'
import { STRUCTURED_AGENT_SESSION_QUEUED_METHODS } from './structured-agent-session-queued-methods'
import { STRUCTURED_AGENT_SESSION_RESTART_RESUME_METHODS } from './structured-agent-session-restart-resume'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
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

/**
 * The attach-shaped entries take the location from the client instead of resolving it from a
 * worktree, so they never reach the worktree-resolving create-support check. Ask the executing
 * host the same question directly: only it knows which agents and locations it runs, and a client
 * cannot forge that answer.
 */
async function resolveClientSuppliedAttach(params: z.infer<typeof AttachParams>, ctx: RpcContext) {
  await ensureHostInstalled(ctx, params.agent)
  const host = requireHost(ctx, params.agent)
  if (!host.supportsCreate(params.location, params.agent)) {
    throw agentSessionRefusalError('structured_agent_session_unsupported', {
      reason: 'hostUnsupported'
    })
  }
  const { agent: _attachAgent, provider: _attachProvider, ...attachWithoutAgent } = params
  const attachParams = {
    ...attachWithoutAgent,
    provider: params.provider as 'claude' | 'codex',
    agent: params.agent as 'claude' | 'codex'
  } as AgentSessionAttachParams
  return { host, attachParams }
}

async function attachClientSuppliedLocation(
  params: z.infer<typeof AttachParams>,
  ctx: RpcContext
): Promise<unknown> {
  const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
  return host.attach(callerFor(ctx), attachParams)
}

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
    handler: async (params, ctx) => {
      requireStructuredAgentAudience(ctx, params.agent)
      if (params.envelope.expectedRuntimeFence !== null) {
        throw agentSessionRefusalError('agent_session_operation_invalid', {
          reason: 'requestMalformed'
        })
      }
      // Everything up to `attach` is pre-commit, and answers with a refusal rather than a throw so
      // a client can tell "nothing was created" from "the outcome is unknown".
      const prepared = await resolveUncommittedStructuredCreate(async () => {
        if ('worktree' in params) {
          const conflict = agentSessionFingerprintConflict(
            params.envelope,
            structuredAgentSessionCreateIntentFingerprint(params)
          )
          if (conflict) {
            return { refusal: conflict }
          }
          return prepareStructuredAgentSessionCreateForWorktree({
            runtime: ctx.runtime,
            ensureHost: async () => {
              await ensureHostInstalled(ctx)
              return requireHost(ctx)
            },
            envelope: params.envelope,
            worktree: params.worktree,
            agent: params.agent,
            caller: callerFor(ctx),
            ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {}),
            ...(params.tabId ? { tabId: params.tabId } : {})
          })
        }
        const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
        return { host, attachParams, tab: null }
      })
      if ('refusal' in prepared) {
        return { ok: false, refusal: prepared.refusal }
      }
      return commitStructuredAgentSessionCreate({
        runtime: ctx.runtime,
        caller: callerFor(ctx),
        prepared,
        activate: true
      })
    }
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
        ...(params.cursor ? { cursor: params.cursor } : {}),
        ...(params.queueView ? { queueView: params.queueView } : {})
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
