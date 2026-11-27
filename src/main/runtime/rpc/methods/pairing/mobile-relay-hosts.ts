import { defineMethod, type RpcContext } from '../../core'
import { resolveWorktreeCatalogSnapshot } from '../../workspace-client-views/worktree-catalog-snapshot'
import {
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MOBILE_RELAY_HOSTS_LIST_METHOD,
  MOBILE_RELAY_HOSTS_UNWATCH_ROWS_METHOD,
  MobileRelayHostWorktreesParamsSchema
} from '../../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { RelayPhoneReader } from '../../../mobile-desktop-relay/mobile-relay-host-rows-announcer'

// Holds a watch for this phone until it disconnects; a phone that can't hear the events costs none.
function capablePhone(ctx: RpcContext, key: string): RelayPhoneReader | undefined {
  const { connectionId, runtime } = ctx
  return connectionId &&
    ctx.clientCapabilities?.includes(MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY)
    ? {
        connectionId,
        // A phone that left while the read awaited is already cleaned up, so it releases now.
        onClose: (release) =>
          ctx.signal?.aborted
            ? release()
            : runtime.registerSubscriptionCleanup(`${key}:${connectionId}`, release, connectionId)
      }
    : undefined
}

export const MOBILE_RELAY_HOSTS_METHODS = [
  defineMethod({
    name: MOBILE_RELAY_HOSTS_LIST_METHOD,
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx) =>
      (await ctx.mobileRelayHosts?.list(capablePhone(ctx, 'relay-host-list'))) ?? { hosts: [] }
  }),
  defineMethod({
    name: MOBILE_RELAY_HOST_WORKTREES_METHOD,
    permission: 'workspace',
    params: MobileRelayHostWorktreesParamsSchema,
    handler: async (params, ctx) => {
      const reader = capablePhone(ctx, `relay-host-rows:${params.hostId}`)
      const result = (await ctx.mobileRelayHosts?.worktrees(params.hostId, reader)) ?? {
        worktrees: null
      }
      // Why: a server without rows yet gets the plain reply.
      return result.worktrees
        ? resolveWorktreeCatalogSnapshot({ worktrees: result.worktrees }, params)
        : result
    }
  }),
  defineMethod({
    name: MOBILE_RELAY_HOSTS_UNWATCH_ROWS_METHOD,
    permission: 'workspace',
    params: null,
    handler: async (_params, ctx) => {
      if (ctx.connectionId) {
        ctx.mobileRelayHosts?.releaseRowHolds?.(ctx.connectionId)
      }
      return { ok: true }
    }
  })
]
