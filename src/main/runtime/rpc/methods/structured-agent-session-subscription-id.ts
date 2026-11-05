// Frame ids isolate streams multiplexed on one socket; append only when present, never substitute one shared missing-id constant.

import type { RpcContext } from '../core'

const SUBSCRIPTION_PREFIX = 'agentSession'

function withFrameId(ctx: RpcContext, base: string): string {
  return ctx.requestId ? `${base}:${ctx.requestId}` : base
}

/** Session stream base; unsubscribe also sweeps every base:frame child. */
export function structuredAgentSessionSubscriptionBase(ctx: RpcContext, sessionId: string): string {
  return `${SUBSCRIPTION_PREFIX}:${ctx.connectionId ?? 'local'}:${sessionId}`
}

/** One session's transcript stream. */
export function structuredAgentSessionSubscriptionId(ctx: RpcContext, sessionId: string): string {
  return withFrameId(ctx, structuredAgentSessionSubscriptionBase(ctx, sessionId))
}

/** The status feed, which is per connection rather than per session. */
export function structuredAgentSessionStatusSubscriptionId(ctx: RpcContext): string {
  return withFrameId(ctx, `${SUBSCRIPTION_PREFIX}.status:${ctx.connectionId ?? 'local'}`)
}

/** The turn-completion feed, which like the status feed is per connection, not per session. */
export function structuredAgentSessionTurnCompletionSubscriptionId(ctx: RpcContext): string {
  return withFrameId(ctx, `${SUBSCRIPTION_PREFIX}.turn-completion:${ctx.connectionId ?? 'local'}`)
}

/** The availability feed, per connection like the status feed. */
export function structuredAgentSessionAvailabilitySubscriptionId(ctx: RpcContext): string {
  return withFrameId(ctx, `${SUBSCRIPTION_PREFIX}.availability:${ctx.connectionId ?? 'local'}`)
}
