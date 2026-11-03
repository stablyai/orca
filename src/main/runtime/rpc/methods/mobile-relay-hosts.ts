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
      // Why: a server without rows yet gets the plain reply.
      return result.worktrees
        ? resolveWorktreeCatalogSnapshot({ worktrees: result.worktrees }, params)
        : result
    }
  })
]
