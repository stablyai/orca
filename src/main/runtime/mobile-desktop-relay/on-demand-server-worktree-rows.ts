import type { MobileRelayServerWorktreeRow } from '../../../shared/mobile-relay-hosts-contract'
import {
  SERVER_FETCH_TIMEOUT_MS,
  SERVER_WORKTREE_LIMIT,
  WorktreePsReplySchema,
  stampServerWorktreeRows
} from './server-worktree-fetch'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import type { ServerWorktreeRows } from './mobile-relay-host-catalog'
import {
  describeRelayHosts,
  relayHostFence,
  type DescribedRelayHost
} from './mobile-relay-host-descriptions'

type CachedServerWorktrees = {
  fence: string
  worktrees: MobileRelayServerWorktreeRow[]
}

/** Each server's rows as the desktop last fetched them for a phone request; nothing runs between. */
export class OnDemandServerWorktreeRows implements ServerWorktreeRows {
  private readonly cached = new Map<string, CachedServerWorktrees>()
  // Keyed by server identity, so a poll after a re-pair never joins the old server's fetch.
  private readonly refreshing = new Map<string, Promise<void>>()

  constructor(private readonly hosts: MobileDesktopRelayHosts) {}

  // Why lazily, not on retirement: a disconnected server keeps its rows; only a removed one loses them.
  sync(): void {
    const configured = new Set(this.hosts.list().environments.map((environment) => environment.id))
    for (const environmentId of this.cached.keys()) {
      if (!configured.has(environmentId)) {
        this.cached.delete(environmentId)
      }
    }
  }

  refresh(environmentId: string): Promise<void> {
    const host = describeRelayHosts(this.hosts).find(
      (entry) => entry.environmentId === environmentId
    )
    if (!host) {
      return Promise.resolve()
    }
    const key = `${host.environmentId}\0${relayHostFence(host.identity)}`
    const inFlight = this.refreshing.get(key)
    if (inFlight) {
      return inFlight
    }
    const refresh = this.fetchAsDesktop(host).finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, refresh)
    return refresh
  }

  rows(environmentId: string, fence: string): readonly MobileRelayServerWorktreeRow[] | null {
    const cached = this.cached.get(environmentId)
    return cached && cached.fence === fence ? cached.worktrees : null
  }

  private async fetchAsDesktop(host: DescribedRelayHost): Promise<void> {
    try {
      const response = await this.hosts.call(
        host,
        'worktree.ps',
        { limit: SERVER_WORKTREE_LIMIT, supportsWorktreeVisibilitySourceDefaults: true },
        // Why the transport bound too: it ends the hung call, so the next poll fetches afresh instead of joining it.
        { timeoutMs: SERVER_FETCH_TIMEOUT_MS, expected: host.identity }
      )
      const reply = response.ok ? WorktreePsReplySchema.safeParse(response.result) : null
      // Why: a removed server's late answer must not outlive it.
      if (
        !reply?.success ||
        !this.hosts.list().environments.some((entry) => entry.id === host.environmentId)
      ) {
        return
      }
      this.cached.set(host.environmentId, {
        // Why the identity taken before the fetch: the call's own check cannot see a re-pair after dispatch.
        fence: relayHostFence(host.identity),
        worktrees: stampServerWorktreeRows(host.environmentId, reply.data.worktrees)
      })
    } catch {
      // An unreachable server keeps its last rows.
    }
  }
}
