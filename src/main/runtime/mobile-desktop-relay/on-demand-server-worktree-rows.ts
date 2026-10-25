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

/** Fetch only on phone requests; preserve last-known rows between them. */
export class OnDemandServerWorktreeRows implements ServerWorktreeRows {
  private readonly cached = new Map<string, CachedServerWorktrees>()
  // Identity-scoped fetches prevent re-pairing from joining old-server work.
  private readonly refreshing = new Map<string, Promise<void>>()

  constructor(private readonly hosts: MobileDesktopRelayHosts) {}

  // Disconnects retain rows; prune only removed servers when syncing.
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
        // Bound the transport too, so the next poll cannot join an indefinitely hung call.
        { timeoutMs: SERVER_FETCH_TIMEOUT_MS, expected: host.identity }
      )
      const reply = response.ok ? WorktreePsReplySchema.safeParse(response.result) : null
      // Removed servers must not repopulate rows with late replies.
      if (
        !reply?.success ||
        !this.hosts.list().environments.some((entry) => entry.id === host.environmentId)
      ) {
        return
      }
      this.cached.set(host.environmentId, {
        // Capture identity before dispatch; transport checks cannot see later re-pairing.
        fence: relayHostFence(host.identity),
        worktrees: stampServerWorktreeRows(host.environmentId, reply.data.worktrees)
      })
    } catch {}
  }
}
