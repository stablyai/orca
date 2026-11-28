import { defineMethod, type RpcContext } from '../../core'
import {
  resolveWorktreeCatalogSnapshot,
  WorktreeCatalogRowHashes
} from '../../workspace-client-views/worktree-catalog-snapshot'
import {
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MOBILE_RELAY_HOSTS_LIST_METHOD,
  MOBILE_RELAY_HOSTS_UNWATCH_ROWS_METHOD,
  MobileRelayHostWorktreesParamsSchema
} from '../../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { RelayPhoneReader } from '../../../mobile-desktop-relay/mobile-relay-host-rows-announcer'

// Per relayed server, so a phone's re-read after one row changed hashes that row, not the whole server.
const rowHashesByServer = new Map<string, WorktreeCatalogRowHashes>()

function serverRowHashes(hostId: string): WorktreeCatalogRowHashes {
  let rowHashes = rowHashesByServer.get(hostId)
  if (!rowHashes) {
    rowHashes = new WorktreeCatalogRowHashes()
    rowHashesByServer.set(hostId, rowHashes)
  }
  return rowHashes
}

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
      if (!result.worktrees) {
        rowHashesByServer.delete(params.hostId)
        return result
      }
      return resolveWorktreeCatalogSnapshot(
        { worktrees: result.worktrees },
        params,
        serverRowHashes(params.hostId)
      )
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
