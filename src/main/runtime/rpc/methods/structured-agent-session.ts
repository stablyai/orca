// `agentSession.*` — the structured session RPC surface.
//
// Every method here is gated on the client advertising
// `agent-session.structured.v1`. A client that does not is told the surface does
// not exist rather than receiving the journal or mutation surface. Session-tab
// inventory may expose only a metadata placeholder for an incapable mobile client.

import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../../shared/agent-session-mutation-envelope'
import type { z } from 'zod'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
import {
  ensureStructuredHostInstalled as ensureHostInstalled,
  requireStructuredCapability,
  requireStructuredCleanupHost,
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor,
  supportsStructuredSessions
} from './structured-agent-session-gate'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import {
  commitStructuredAgentSessionCreate,
  prepareStructuredAgentSessionCreateForWorktree
} from './structured-agent-session-create'
import { STRUCTURED_AGENT_SESSION_HOLD_METHODS } from './structured-agent-session-hold'
import { STRUCTURED_AGENT_SESSION_REVEAL_METHODS } from './structured-agent-session-reveal'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import {
  bindStructuredAgentSessionStream,
  STRUCTURED_AGENT_SESSION_STATUS_METHODS
} from './structured-agent-session-status-stream'
import {
  structuredAgentSessionSubscriptionBase as subscriptionBaseFor,
  structuredAgentSessionSubscriptionId as subscriptionIdFor
} from './structured-agent-session-subscription-id'
import {
  AttachParams,
  CancelParams,
  ConversationCommandParams,
  CreateParams,
  CreateSupportParams,
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

/**
 * The attach-shaped entries take the location from the client instead of resolving it from a
 * worktree, so they never reach the worktree-resolving create-support check. Ask the executing
 * host the same question directly: the answer includes host-measured facts the client cannot see
 * or forge, such as whether this machine can read a provider child's process start time.
 */
async function resolveClientSuppliedAttach(params: z.infer<typeof AttachParams>, ctx: RpcContext) {
  await ensureHostInstalled(ctx)
  const host = requireHost(ctx)
  if (!host.supportsCreate(params.location, params.agent)) {
    throw new Error('structured_agent_session_unsupported')
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

export const STRUCTURED_AGENT_SESSION_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'agentSession.rewind',
    params: RewindParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx)
      return requireHost(ctx).rewind(callerFor(ctx), params)
    }
  }),
  defineMethod({
    name: 'agentSession.conversationCommand',
    params: ConversationCommandParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      await ensureHostInstalled(ctx)
      const host = requireHost(ctx)
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
    name: 'agentSession.createSupport',
    params: CreateSupportParams,
    handler: async (params, ctx) => {
      if (!supportsStructuredSessions(ctx)) {
        throw new Error('structured_agent_session_unsupported')
      }
      return ctx.runtime.getStructuredAgentSessionCreateSupport(params.worktree, params.agent)
    }
  }),
  defineMethod({
    name: 'agentSession.create',
    params: CreateParams,
    handler: async (params, ctx) => {
      requireStructuredCapability(ctx)
      if (params.envelope.expectedRuntimeFence !== null) {
        throw new Error('agent_session_operation_invalid')
      }
      // Everything up to `attach` is pre-commit, and answers with a refusal rather than a throw so
      // a client can tell "nothing was created" from "the outcome is unknown".
      const prepared = await resolveUncommittedStructuredCreate(async () => {
        if ('worktree' in params) {
          const intentFingerprint = computeAgentSessionPayloadFingerprint({
            method: 'agentSession.create',
            sessionId: params.envelope.sessionId,
            // `resumeFrom` is part of the intent, not a detail of it: without it here, a retry of
            // "adopt this conversation" would replay as, or conflict with, a blank create. The
            // canonicalizer drops `undefined`, so plain creates keep the digest they always had.
            fields: {
              worktree: params.worktree,
              agent: params.agent,
              resumeFrom: params.resumeFrom
            }
          })
          const conflict = agentSessionFingerprintConflict(params.envelope, intentFingerprint)
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
            agent: params.agent as 'claude' | 'codex',
            caller: callerFor(ctx),
            ...(params.resumeFrom ? { resumeFrom: params.resumeFrom } : {})
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
    params: AttachParams,
    handler: async (params, ctx) => attachClientSuppliedLocation(params, ctx)
  }),
  defineMethod({
    name: 'agentSession.send',
    params: SendParams,
    handler: async (params, ctx) => requireHost(ctx).send(callerFor(ctx), params)
  }),
  defineMethod({
    // Stopping a turn, so it stays available after admission is revoked: see the gate's rule.
    name: 'agentSession.cancel',
    params: CancelParams,
    handler: async (params, ctx) => requireStructuredCleanupHost(ctx).cancel(callerFor(ctx), params)
  }),
  defineMethod({
    // Releasing a chat view, not ending a conversation: the record and journal stay on disk so the
    // same session can be attached again. Only the provider child and the in-memory entry go.
    name: 'agentSession.close',
    params: OptionsParams,
    handler: async (params, ctx) => {
      // Cleanup gate: turning the host setting off must not strand an open chat whose owner can
      // then never close it. See the rule on `requireStructuredCleanupHost`.
      const host = requireStructuredCleanupHost(ctx)
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
      requireHost(ctx).respondToPrompt(callerFor(ctx), { ...params, kind: 'approval' })
  }),
  defineMethod({
    name: 'agentSession.respondToQuestion',
    params: RespondParams,
    handler: async (params, ctx) =>
      requireHost(ctx).respondToPrompt(callerFor(ctx), { ...params, kind: 'question' })
  }),
  defineMethod({
    name: 'agentSession.setOption',
    params: SetOptionParams,
    handler: async (params, ctx) => requireHost(ctx).setOption(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.requestHandoff',
    params: HandoffParams,
    handler: async (params, ctx) => requireHost(ctx).requestHandoff(callerFor(ctx), params)
  }),
  defineMethod({
    name: 'agentSession.handoffStatus',
    params: HandoffStatusParams,
    handler: async (params, ctx) => requireHost(ctx).handoffStatus(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.options',
    params: OptionsParams,
    handler: async (params, ctx) => requireHost(ctx).readOptions(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.commands',
    params: OptionsParams,
    handler: async (params, ctx) => requireHost(ctx).readCommands(params.sessionId)
  }),
  defineMethod({
    name: 'agentSession.history',
    params: HistoryParams,
    handler: async (params, ctx) => requireHost(ctx).history(params)
  }),
  defineStreamingMethod({
    name: 'agentSession.subscribe',
    params: SubscribeParams,
    handler: async (params, ctx, emit) => {
      const host = requireHost(ctx)
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
  ...STRUCTURED_AGENT_SESSION_STATUS_METHODS
]
