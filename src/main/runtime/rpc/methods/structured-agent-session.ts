// `agentSession.*` — the structured session RPC surface.
//
// Every method here is gated on the client advertising
// `agent-session.structured.v1`. A client that does not is told the surface does
// not exist rather than receiving the journal or mutation surface. Session-tab
// inventory may expose only a metadata placeholder for an incapable mobile client.

import { defineMethod, defineStreamingMethod, type RpcAnyMethod } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredCapability,
  requireStructuredCleanupHost,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor
} from './structured-agent-session-gate'
import { STRUCTURED_AGENT_SESSION_CREATE_METHODS } from './structured-agent-session-create-methods'
import { STRUCTURED_AGENT_SESSION_HOLD_METHODS } from './structured-agent-session-hold'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './structured-agent-session-reveal'
import {
  bindStructuredAgentSessionStream,
  STRUCTURED_AGENT_SESSION_STATUS_METHODS
} from './structured-agent-session-status-stream'
import {
  structuredAgentSessionSubscriptionBase as subscriptionBaseFor,
  structuredAgentSessionSubscriptionId as subscriptionIdFor
} from './structured-agent-session-subscription-id'
import {
  CancelParams,
  ConversationCommandParams,
  HistoryParams,
  HandoffParams,
  HandoffStatusParams,
  OptionsParams,
  RespondParams,
  RewindParams,
  SendParams,
  SetOptionParams,
  SubscribeParams,
  UnsubscribeParams
} from './structured-agent-session-schemas'

export const STRUCTURED_AGENT_SESSION_METHODS: RpcAnyMethod[] = [
  ...STRUCTURED_AGENT_SESSION_CREATE_METHODS,
  defineMethod({
    name: 'agentSession.rewind',
    params: RewindParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx, { sessionId: params.envelope.sessionId })
      return requireHost(ctx, params.envelope.sessionId).rewind(callerFor(ctx), params)
    }
  }),
  defineMethod({
    name: 'agentSession.conversationCommand',
    params: ConversationCommandParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx, { sessionId: params.envelope.sessionId })
      const host = requireHost(ctx, params.envelope.sessionId)
      await host.revealSession(params.envelope.sessionId)
      const result = await host.conversationCommand(callerFor(ctx), params)
      if (result.ok && result.value.command === 'clear' && result.value.replacementSessionId) {
        const replacement = host
          .conversationReplacements()
          .find((entry) => entry.sourceSessionId === params.envelope.sessionId)
        if (replacement) {
          await ctx.runtime.replaceStructuredAgentSessionTab(replacement)
        }
        await host.close(params.envelope.sessionId)
      }
      return result
    }
  }),
  defineMethod({
    name: 'agentSession.send',
    params: SendParams,
    handler: async (params, ctx) =>
      requireHost(ctx, params.envelope.sessionId).send(callerFor(ctx), params)
  }),
  defineMethod({
    // Stopping a turn, so it stays available after admission is revoked: see the gate's rule.
    name: 'agentSession.cancel',
    params: CancelParams,
    handler: async (params, ctx) =>
      requireStructuredCleanupHost(ctx, params.envelope.sessionId).cancel(callerFor(ctx), params)
  }),
  defineMethod({
    // Releasing a chat view, not ending a conversation: the record and journal stay on disk so the
    // same session can be attached again. Only the provider child and the in-memory entry go.
    name: 'agentSession.close',
    params: OptionsParams,
    handler: async (params, ctx) => {
      // Cleanup gate: turning the host setting off must not strand an open chat whose owner can
      // then never close it. See the rule on `requireStructuredCleanupHost`.
      const host = requireStructuredCleanupHost(ctx, params.sessionId)
      // Terminal-disposal closes use this RPC without the session-tabs retirement RPC.
      if (typeof host.setSessionTabVisibility === 'function') {
        await host.setSessionTabVisibility(params.sessionId, false)
      }
      await host.close(params.sessionId)
      return { ok: true as const }
    }
  }),
  defineMethod({
    name: 'agentSession.respondToApproval',
    params: RespondParams,
    handler: async (params, ctx) =>
      requireHost(ctx, params.envelope.sessionId).respondToPrompt(callerFor(ctx), {
        ...params,
        kind: 'approval'
      })
  }),
  defineMethod({
    name: 'agentSession.respondToQuestion',
    params: RespondParams,
    handler: async (params, ctx) =>
      requireHost(ctx, params.envelope.sessionId).respondToPrompt(callerFor(ctx), {
        ...params,
        kind: 'question'
      })
  }),
  defineMethod({
    name: 'agentSession.setOption',
    params: SetOptionParams,
    handler: async (params, ctx) =>
      requireHost(ctx, params.envelope.sessionId).setOption(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.requestHandoff',
    params: HandoffParams,
    handler: async (params, ctx) =>
      requireHost(ctx, params.envelope.sessionId).requestHandoff(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.handoffStatus',
    params: HandoffStatusParams,
    handler: async (params, ctx) =>
      requireHost(ctx, params.sessionId).handoffStatus(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.options',
    params: OptionsParams,
    handler: async (params, ctx) => requireHost(ctx, params.sessionId).readOptions(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.commands',
    params: OptionsParams,
    handler: async (params, ctx) =>
      requireHost(ctx, params.sessionId).readCommands(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.history',
    params: HistoryParams,
    handler: async (params, ctx) => requireHost(ctx, params.sessionId).history(params)
  }),
  defineStreamingMethod({
    name: 'agentSession.subscribe',
    params: SubscribeParams,
    handler: async (params, ctx, emit) => {
      const host = requireHost(ctx, params.sessionId)
      const subscriptionId = subscriptionIdFor(ctx, params.sessionId)
      // A live stream is a surface too: it keeps a session from being evicted while it is read and
      // releases that retention when the transport dies without a word.
      //
      // Retain-only: reading history must never be what starts a provider process. Current clients
      // explicitly hold every open surface before subscribing.
      const streamHolder = `subscription:${subscriptionId}`
      let dispose = (): void => {}
      const stream = bindStructuredAgentSessionStream(ctx, subscriptionId, () => {
        dispose()
        host.release(params.sessionId, streamHolder)
      })
      if (stream.isClosed()) {
        return
      }
      // The host emits the opening snapshot (or the missed batch) synchronously
      // inside open(), so nothing between here and there can interleave.
      dispose = host.subscribe({
        id: subscriptionId,
        sessionId: params.sessionId,
        emit,
        ...(params.cursor ? { cursor: params.cursor } : {})
      })
      if (stream.isClosed()) {
        dispose()
      } else {
        // Fire-and-forget, but never unhandled: a resume that refuses leaves the stream holding a
        // readable session, which is exactly what the client sees anyway.
        void host
          .hold(params.sessionId, streamHolder, { resume: false })
          .catch((error: unknown) =>
            console.warn('[agent-session] stream hold failed', params.sessionId, error)
          )
      }
    }
  }),
  defineMethod({
    name: 'agentSession.unsubscribe',
    params: UnsubscribeParams,
    handler: async (params, ctx) => {
      // Why: cleanup must stay available after the setting is disabled, so an admitted caller can
      // retire resources it already owns; the base still comes from main's shared helper.
      requireStructuredCleanupHost(ctx, params.sessionId)
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
  ...STRUCTURED_AGENT_SESSION_STATUS_METHODS
]
