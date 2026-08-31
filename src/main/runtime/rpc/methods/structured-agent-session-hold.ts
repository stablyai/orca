// `agentSession.hold` / `agentSession.release` — a surface saying it is bound to a session.
//
// The holder identity is scoped to the CONNECTION, not taken from the client verbatim: two clients
// are free to name their surfaces the same thing, and a hold that collides is one that a stranger
// can release.
//
// The registered cleanup is the backstop, and the ONLY thing that covers a client which vanishes —
// a paired client that disconnects mid-turn never gets to send its release. Registering it before taking
// the hold is deliberate: re-registering an id runs the previous cleanup synchronously, so the
// stale release lands before this hold rather than after it.

import { defineMethod, type RpcAnyMethod, type RpcContext } from '../core'
import {
  ensureStructuredHostInstalled,
  requireStructuredHost
} from './structured-agent-session-gate'
import { HoldParams } from './structured-agent-session-schemas'

const HOLD_CLEANUP_PREFIX = 'agentSession.hold'

function holderKeyFor(ctx: RpcContext, holderId: string): string {
  const client = ctx.clientId?.trim() || (ctx.clientKind ?? 'runtime')
  return `${ctx.connectionId ?? 'local'}:${client}:${holderId}`
}

function holdCleanupIdFor(sessionId: string, holderKey: string): string {
  return `${HOLD_CLEANUP_PREFIX}:${holderKey}:${sessionId}`
}

export const STRUCTURED_AGENT_SESSION_HOLD_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: 'agentSession.hold',
    params: HoldParams,
    handler: async (params, ctx) => {
      await ensureStructuredHostInstalled(ctx)
      const host = requireStructuredHost(ctx)
      const holderKey = holderKeyFor(ctx, params.holderId)
      ctx.runtime.registerSubscriptionCleanup(
        holdCleanupIdFor(params.sessionId, holderKey),
        () => host.release(params.sessionId, holderKey),
        ctx.connectionId
      )
      try {
        await host.hold(params.sessionId, holderKey)
      } catch (error) {
        ctx.runtime.cleanupSubscription(holdCleanupIdFor(params.sessionId, holderKey))
        throw error
      }
      return { held: true as const }
    }
  }),
  defineMethod({
    name: 'agentSession.release',
    params: HoldParams,
    handler: async (params, ctx) => {
      const host = requireStructuredHost(ctx)
      const holderKey = holderKeyFor(ctx, params.holderId)
      host.release(params.sessionId, holderKey)
      // Retires the backstop too; its release is a no-op against a holder already gone.
      ctx.runtime.cleanupSubscription(holdCleanupIdFor(params.sessionId, holderKey))
      return { released: true as const }
    }
  })
]
