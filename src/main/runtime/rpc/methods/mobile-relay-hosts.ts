import { defineMethod } from '../core'
import { resolveWorktreeCatalogSnapshot } from '../worktree-catalog-snapshot'
import {
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MOBILE_RELAY_HOSTS_LIST_METHOD,
  MobileRelayHostWorktreesParamsSchema
} from '../../../../shared/mobile-relay-hosts-contract'

export const MOBILE_RELAY_HOSTS_METHODS = [
  defineMethod({
    name: MOBILE_RELAY_HOSTS_LIST_METHOD,
    permission: 'workspace',
    params: null,
    handler: (_params, ctx) => ctx.mobileRelayHosts?.list() ?? { hosts: [] }
  }),
  defineMethod({
    name: MOBILE_RELAY_HOST_WORKTREES_METHOD,
    permission: 'workspace',
    params: MobileRelayHostWorktreesParamsSchema,
    handler: async (params, ctx) => {
      const result = (await ctx.mobileRelayHosts?.worktrees(params.hostId)) ?? { worktrees: null }
      // Why: callers that send neither field, and servers without rows yet, get the plain reply.
      if (!result.worktrees || (params.afterSnapshotId === undefined && !params.acceptRowDelta)) {
        return result
      }
      return resolveWorktreeCatalogSnapshot(
        { worktrees: result.worktrees },
        params.afterSnapshotId ?? null,
        { acceptRowDelta: params.acceptRowDelta === true }
      )
    }
  })
]
