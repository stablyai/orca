// `agentSession.*` — the structured session RPC surface.
//
// Every method here is gated on the client advertising
// `agent-session.structured.v1`. A client that does not is told the surface does
// not exist rather than being handed a session it cannot render or drive; that
// is the whole visibility rule, because nothing else on the runtime publishes a
// structured session.

import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import {
  agentSessionFingerprintConflict,
  computeAgentSessionPayloadFingerprint
} from '../../../../shared/agent-session-mutation-envelope'
import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-registry'
import type { StructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/structured-agent-session-host'
import type { StructuredAgentSessionCaller } from '../../../native-chat/agent-session-wire/structured-agent-session-host-types'
import { defineMethod, defineStreamingMethod, type RpcAnyMethod, type RpcContext } from '../core'
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
import { hasMobileClipboardImagePath } from '../mobile-clipboard-image-provenance'

const SUBSCRIPTION_PREFIX = 'agentSession'

/**
 * In-process callers are the same build as the host, so they carry no negotiated
 * capability list; every remote client must say it can read structured sessions.
 */
function supportsStructuredSessions(ctx: RpcContext): boolean {
  return (
    ctx.clientKind === undefined ||
    (ctx.clientCapabilities?.includes(STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY) ?? false)
  )
}

function requireStructuredCapability(ctx: RpcContext): void {
  if (!supportsStructuredSessions(ctx)) {
    throw new Error('structured_agent_session_unsupported')
  }
}

function requireHost(ctx: RpcContext): StructuredAgentSessionHost {
  requireStructuredCapability(ctx)
  const host = getStructuredAgentSessionHost()
  if (!host) {
    throw new Error('structured_agent_session_unsupported')
  }
  return host
}

function assertMobileImageProvenance(
  ctx: RpcContext,
  body: { blocks: { type: string; path?: string; url?: string }[] }
): void {
  if (ctx.clientKind !== 'mobile') {
    return
  }
  for (const block of body.blocks) {
    if (block.type !== 'image-ref') {
      continue
    }
    if (block.url || !block.path || !hasMobileClipboardImagePath(ctx.clientId, block.path)) {
      throw new Error('agent_session_image_untrusted')
    }
  }
}

function assertLocalEffectAuthority(ctx: RpcContext, effectAuthority: unknown): void {
  if (!effectAuthority) {
    return
  }
  if (
    ctx.clientKind !== 'runtime' ||
    ctx.clientId !== 'desktop-renderer' ||
    ctx.connectionId !== undefined
  ) {
    throw new Error('local_structured_write_requires_local_desktop_renderer')
  }
}

function isTrustedLocalUserTurn(ctx: RpcContext): boolean {
  return (
    ctx.clientKind === 'runtime' &&
    ctx.clientId === 'desktop-renderer' &&
    ctx.connectionId === undefined
  )
}

/** Attach is the only way a session comes into being, so it is the only call
 *  that builds the host. Every other method addresses a session that must
 *  already be attached, and correctly reports absent when none is. */
async function ensureHostInstalled(ctx: RpcContext): Promise<void> {
  // Gated first: a client that cannot read structured sessions must not be able
  // to make the host exist, which is an observable side effect of the surface.
  if (!supportsStructuredSessions(ctx) || getStructuredAgentSessionHost()) {
    return
  }
  await ctx.runtime.ensureStructuredAgentSessionHost()
}

/** Mirrors the existing agent-session host-authority derivation so one client
 *  gets one operation namespace across both surfaces. */
function callerFor(ctx: RpcContext): StructuredAgentSessionCaller {
  return {
    callerKey: ctx.clientId?.trim() || `trusted-local:${ctx.clientKind ?? 'runtime'}`
  }
}

function subscriptionIdFor(ctx: RpcContext, sessionId: string): string {
  const base = `${SUBSCRIPTION_PREFIX}:${ctx.connectionId ?? 'local'}:${sessionId}`
  // Shared control multiplexes several streams over one socket; the frame id
  // keeps one subscriber from evicting another on the same session.
  return ctx.requestId ? `${base}:${ctx.requestId}` : base
}

export const STRUCTURED_AGENT_SESSION_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'agentSession.createSupport',
    params: CreateSupportParams,
    handler: async (params, ctx) => {
      if (!supportsStructuredSessions(ctx)) {
        throw new Error('structured_agent_session_unsupported')
      }
      assertLocalEffectAuthority(ctx, params.effectAuthority)
      return ctx.runtime.getStructuredAgentSessionCreateSupport(
        params.worktree,
        params.agent,
        params.effectAuthority
      )
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
      if ('worktree' in params) {
        assertLocalEffectAuthority(ctx, params.effectAuthority)
        const intentFingerprint = computeAgentSessionPayloadFingerprint({
          method: 'agentSession.create',
          sessionId: params.envelope.sessionId,
          fields: {
            worktree: params.worktree,
            agent: params.agent,
            effectAuthority: params.effectAuthority
          }
        })
        const conflict = agentSessionFingerprintConflict(params.envelope, intentFingerprint)
        if (conflict) {
          return { ok: false, refusal: conflict }
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
            effectIsolation: resolved.effectIsolation,
            runtimeKind: resolved.runtimeKind,
            expectedRuntimeFence: null
          }
        })
        await ensureHostInstalled(ctx)
        const result = await requireHost(ctx).attach(callerFor(ctx), {
          ...resolved,
          envelope: { ...params.envelope, payloadFingerprint: hostFingerprint }
        })
        if (result.ok) {
          ctx.runtime.publishStructuredAgentSessionTab({
            workspaceId: resolved.location.workspaceId,
            sessionId: result.value.sessionId,
            agent: 'codex',
            activate: true
          })
        }
        return result
      }
      if (ctx.clientKind === 'mobile') {
        throw new Error('agent_session_create_intent_required')
      }
      await ensureHostInstalled(ctx)
      return requireHost(ctx).attach(callerFor(ctx), params)
    }
  }),
  defineMethod({
    name: 'agentSession.ensure',
    params: AttachParams,
    handler: async (params, ctx) => {
      await ensureHostInstalled(ctx)
      return requireHost(ctx).attach(callerFor(ctx), params)
    }
  }),
  defineMethod({
    name: 'agentSession.send',
    params: SendParams,
    handler: async (params, ctx) => {
      const host = requireHost(ctx)
      assertLocalEffectAuthority(ctx, params.effectAuthority)
      if (isTrustedLocalUserTurn(ctx)) {
        await host.invalidateEffectAuthorityForTrustedUserTurn(params.envelope.sessionId)
      }
      return host.send(callerFor(ctx), {
        ...params,
        beforeRun: () => assertMobileImageProvenance(ctx, params.body)
      })
    }
  }),
  defineMethod({
    name: 'agentSession.cancel',
    params: CancelParams,
    handler: async (params, ctx) => requireHost(ctx).cancel(callerFor(ctx), params)
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
      let closed = false
      let dispose = (): void => {}
      ctx.runtime.registerSubscriptionCleanup(
        subscriptionId,
        () => {
          closed = true
          dispose()
        },
        ctx.connectionId
      )
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
  })
]
