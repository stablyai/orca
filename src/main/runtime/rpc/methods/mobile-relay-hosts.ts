import { defineMethod, type RpcContext } from '../core'
import {
  MOBILE_RELAY_HOST_SLEEP_WORKTREE_METHOD,
  MOBILE_RELAY_HOST_WAKE_SLEEPING_AGENTS_METHOD,
  MOBILE_RELAY_HOST_WORKTREES_METHOD,
  MOBILE_RELAY_HOSTS_LIST_METHOD,
  MobileRelayHostWorktreeParamsSchema,
  MobileRelayHostWorktreesParamsSchema
} from '../../../../shared/mobile-relay-hosts-contract'

/** Refuses a server the desktop has not configured; read from its settings, not a fetched list. */
function assertConfiguredServer(hosts: RpcContext['mobileRelayHosts'], hostId: string): void {
  if (!hosts?.list().hosts.some((host) => host.hostId === hostId)) {
    throw new Error('selector_not_found')
  }
}

export const MOBILE_RELAY_HOSTS_METHODS = [
  defineMethod({
    name: MOBILE_RELAY_HOSTS_LIST_METHOD,
    params: null,
    // Why empty rather than an error: a desktop that relays nowhere has no servers to show.
    handler: (_params, ctx) => ctx.mobileRelayHosts?.list() ?? { hosts: [] }
  }),
  defineMethod({
    name: MOBILE_RELAY_HOST_WORKTREES_METHOD,
    params: MobileRelayHostWorktreesParamsSchema,
    handler: async (params, ctx) =>
      (await ctx.mobileRelayHosts?.worktrees(params.hostId)) ?? { worktrees: null }
  }),
  defineMethod({
    name: MOBILE_RELAY_HOST_SLEEP_WORKTREE_METHOD,
    params: MobileRelayHostWorktreeParamsSchema,
    handler: (params, { runtime, mobileRelayHosts }) => {
      assertConfiguredServer(mobileRelayHosts, params.hostId)
      return runtime.requestWorktreeSleep(params.worktreeId)
    }
  }),
  defineMethod({
    name: MOBILE_RELAY_HOST_WAKE_SLEEPING_AGENTS_METHOD,
    params: MobileRelayHostWorktreeParamsSchema,
    handler: (params, { runtime, mobileRelayHosts }) => {
      assertConfiguredServer(mobileRelayHosts, params.hostId)
      return {
        sleepingAgentWake: runtime.requestSleepingAgentWake(params.worktreeId, params.hostId)
      }
    }
  })
]
