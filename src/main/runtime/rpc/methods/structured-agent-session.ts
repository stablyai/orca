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
  requireStructuredHost as requireHost,
  structuredCallerFor as callerFor,
  supportsStructuredSessions
} from './structured-agent-session-gate'
import type { AgentSessionAttachParams } from '../../../native-chat/agent-session-wire/structured-agent-session-attach'
import { STRUCTURED_AGENT_SESSION_HOLD_METHODS } from './structured-agent-session-hold'
import { resolveUncommittedStructuredCreate } from './structured-agent-session-precommit-refusal'
import {
  AttachParams,
  CancelParams,
  CreateParams,
  CreateSupportParams,
  HistoryParams,
  HandoffParams,
  HandoffStatusParams,
  OptionsParams,
  RespondParams,
  SendParams,
  SetOptionParams,
  SubscribeParams,
  UnsubscribeParams
} from './structured-agent-session-schemas'

const SUBSCRIPTION_PREFIX = 'agentSession'

function subscriptionIdFor(ctx: RpcContext, sessionId: string): string {
  const base = `${SUBSCRIPTION_PREFIX}:${ctx.connectionId ?? 'local'}:${sessionId}`
  // Shared control multiplexes several streams over one socket; the frame id
  // keeps one subscriber from evicting another on the same session.
  return ctx.requestId ? `${base}:${ctx.requestId}` : base
}

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
            fields: { worktree: params.worktree, agent: params.agent }
          })
          const conflict = agentSessionFingerprintConflict(params.envelope, intentFingerprint)
          if (conflict) {
            return { refusal: conflict }
          }
          const resolved = await ctx.runtime.resolveStructuredAgentSessionCreateIntent(params)
          const hostFingerprint = computeAgentSessionPayloadFingerprint({
            method: 'agentSession.attach',
            sessionId: params.envelope.sessionId,
            fields: {
              location: resolved.location,
              provider: resolved.provider,
              agent: resolved.agent,
              accountHome: resolved.accountHome,
              runtimeKind: resolved.runtimeKind,
              expectedRuntimeFence: null
            }
          })
          await ensureHostInstalled(ctx)
          const { agent: _resolvedAgent, provider: _resolvedProvider, ...resolvedAttach } = resolved
          const attachParams: AgentSessionAttachParams = {
            ...resolvedAttach,
            provider: resolved.provider as 'claude' | 'codex',
            agent: resolved.agent as 'claude' | 'codex',
            envelope: { ...params.envelope, payloadFingerprint: hostFingerprint }
          }
          return {
            host: requireHost(ctx),
            attachParams,
            tab: {
              workspaceId: resolved.location.workspaceId,
              agent: resolved.agent as 'claude' | 'codex'
            }
          }
        }
        const { host, attachParams } = await resolveClientSuppliedAttach(params, ctx)
        return { host, attachParams, tab: null }
      })
      if ('refusal' in prepared) {
        return { ok: false, refusal: prepared.refusal }
      }
      const result = await prepared.host.attach(callerFor(ctx), prepared.attachParams)
      if (result.ok && prepared.tab) {
        try {
          await ctx.runtime.publishStructuredAgentSessionTab({
            workspaceId: prepared.tab.workspaceId,
            sessionId: result.value.sessionId,
            agent: prepared.tab.agent,
            activate: true
          })
        } catch (error) {
          console.warn('[agent-session] create committed before tab publication failed', error)
          return {
            ok: false,
            refusal: {
              code: 'agent_session_operation_unknown',
              message: 'The chat may have been created, but its tab could not be confirmed.'
            }
          }
        }
      }
      return result
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
    name: 'agentSession.cancel',
    params: CancelParams,
    handler: async (params, ctx) => requireHost(ctx).cancel(callerFor(ctx), params)
  }),
  defineMethod({
    // Releasing a chat view, not ending a conversation: the record and journal stay on disk so the
    // same session can be attached again. Only the provider child and the in-memory entry go.
    name: 'agentSession.close',
    params: OptionsParams,
    handler: async (params, ctx) => {
      const host = requireHost(ctx)
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
      let closed = false
      let dispose = (): void => {}
      let releaseTransportSubscription = (): void => {}
      const onTransportAbort = (): void => releaseTransportSubscription()
      const cleanup = () => {
        closed = true
        ctx.signal?.removeEventListener('abort', onTransportAbort)
        dispose()
        host.release(params.sessionId, streamHolder)
      }
      let registration: { releaseIfCurrent: () => void }
      if (typeof ctx.runtime.registerOwnedSubscriptionCleanup === 'function') {
        registration = ctx.runtime.registerOwnedSubscriptionCleanup(
          subscriptionId,
          cleanup,
          ctx.connectionId
        )
      } else {
        ctx.runtime.registerSubscriptionCleanup(subscriptionId, cleanup, ctx.connectionId)
        registration = { releaseIfCurrent: () => ctx.runtime.cleanupSubscription(subscriptionId) }
      }
      releaseTransportSubscription = registration.releaseIfCurrent
      ctx.signal?.addEventListener('abort', onTransportAbort, { once: true })
      if (ctx.signal?.aborted) {
        onTransportAbort()
      }
      if (closed) {
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
      if (closed) {
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
      requireHost(ctx)
      const connection = ctx.connectionId ?? 'local'
      const base = `${SUBSCRIPTION_PREFIX}:${connection}:${params.sessionId}`
      if (params.subscriptionId) {
        ctx.runtime.cleanupSubscription(`${base}:${params.subscriptionId}`)
        return { unsubscribed: true }
      }
      ctx.runtime.cleanupSubscription(base)
      ctx.runtime.cleanupSubscriptionsByPrefix(`${base}:`)
      return { unsubscribed: true }
    }
  }),
  ...STRUCTURED_AGENT_SESSION_HOLD_METHODS
]
