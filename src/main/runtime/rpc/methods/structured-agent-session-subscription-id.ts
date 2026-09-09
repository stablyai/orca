// Subscription ids for the streaming `agentSession.*` methods.
//
// Shared control multiplexes several streams over one socket, so the frame id keeps one
// subscriber from evicting another. It is appended only when present: collapsing a missing
// frame id to a constant is the collision the rule exists to prevent.

import type { RpcContext } from '../core'

const SUBSCRIPTION_PREFIX = 'agentSession'

function withFrameId(ctx: RpcContext, base: string): string {
  return ctx.requestId ? `${base}:${ctx.requestId}` : base
}

/** The id a session's streams share before the frame id. `unsubscribe` addresses this
 *  directly and sweeps `${base}:` to reach every frame under it. */
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
