import { z } from 'zod'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../shared/execution-host-registry'
import { pickerExecutionHosts } from '../../../shared/managed-orcad-execution-host'
import type {
  MobileRelayHost,
  MobileRelayHostRelay,
  MobileRelayHostsListResult,
  MobileRelayHostWorktreesResult,
  MobileRelayServerWorktreeRow
} from '../../../shared/mobile-relay-hosts-contract'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type {
  MobileDesktopRelayHostListing,
  MobileDesktopRelayHosts
} from './mobile-desktop-relay-hosts'

// Why the phone's own full-catalog limit: the server's default page is 200 and nothing pages on.
const SERVER_WORKTREE_LIMIT = 10_000
// Why well under the phone's 30s request timeout: a hung server must answer with its last rows.
const SERVER_FETCH_TIMEOUT_MS = 5_000

const WorktreePsReplySchema = z.object({
  worktrees: z.array(z.looseObject({})),
  totalCount: z.number(),
  truncated: z.boolean()
})

type CachedServerWorktrees = {
  fence: string
  fetchedAt: number
  worktrees: MobileRelayServerWorktreeRow[]
  totalCount: number
  truncated: boolean
}

type DescribedHost = MobileRelayHost & {
  environmentId: string
  identity: Pick<MobileDesktopRelayHostListing, 'pairingRevision' | 'runtimeId'>
}

/**
 * The configured servers the desktop shows, for the phone: health from the desktop's own status
 * (the sidebar's mapping), and each server's workspace list as the desktop itself last fetched it,
 * so a server that is offline or too old to relay to still lists. Replies relayed to a phone are
 * never read here.
 */
export class MobileRelayHostCatalog {
  private readonly cached = new Map<string, CachedServerWorktrees>()
  // Keyed by server identity, so a poll after a re-pair never joins the old server's fetch.
  private readonly refreshing = new Map<string, Promise<boolean>>()

  constructor(
    private readonly options: {
      hosts: MobileDesktopRelayHosts
      hostLabelOverrides: () => ReadonlyMap<ExecutionHostId, string>
      now?: () => number
    }
  ) {}

  list(): MobileRelayHostsListResult {
    return {
      hosts: this.describe().map(({ hostId, label, health, relay }) => ({
        hostId,
        label,
        health,
        relay
      }))
    }
  }

  async worktrees(hostId: string): Promise<MobileRelayHostWorktreesResult> {
    const parsed = parseExecutionHostId(hostId)
    const host =
      parsed?.kind === 'runtime'
        ? this.describe().find((entry) => entry.environmentId === parsed.environmentId)
        : undefined
    if (!host) {
      return { worktrees: null }
    }
    const refreshed = host.health === 'available' && (await withinFetchBound(this.refresh(host)))
    const cached = this.cached.get(host.environmentId)
    const current = this.options.hosts
      .list()
      .environments.find((environment) => environment.id === host.environmentId)
    // Why the identity read after the fetch: one answered after a re-pair stored the old server's rows.
    if (!cached || !current || cached.fence !== fenceOf(current)) {
      return { worktrees: null }
    }
    // Why: the desktop asks with background-removal support; a phone asking itself never sees these rows.
    const worktrees = cached.worktrees.filter((row) => row.removing !== true)
    return {
      worktrees,
      totalCount: cached.totalCount - (cached.worktrees.length - worktrees.length),
      truncated: cached.truncated,
      fetchedAt: cached.fetchedAt,
      stale: !refreshed
    }
  }

  private describe(): DescribedHost[] {
    const { environments, statusByEnvironmentId, sshTargetLabels, sshConnectionStates } =
      this.options.hosts.list()
    const identities = new Map(environments.map((environment) => [environment.id, environment]))
    // Why lazily, not on retirement: a disconnected server keeps its rows; only a removed one loses them.
    for (const environmentId of this.cached.keys()) {
      if (!identities.has(environmentId)) {
        this.cached.delete(environmentId)
      }
    }
    // Why the desktop's picker rows: a managed server folds into its SSH host as the sidebar shows it.
    return pickerExecutionHosts(
      buildExecutionHostRegistry({
        repos: [],
        settings: null,
        hostSource: 'configured-only',
        sshTargetLabels,
        sshConnectionStates,
        runtimeEnvironments: environments,
        runtimeStatusByEnvironmentId: statusByEnvironmentId,
        hostLabelOverrides: this.options.hostLabelOverrides()
      })
    ).flatMap((entry) => {
      const parsed = parseExecutionHostId(entry.id)
      const identity = parsed?.kind === 'runtime' ? identities.get(parsed.environmentId) : undefined
      if (parsed?.kind !== 'runtime' || !identity) {
        return []
      }
      const answer = lastVerifiedRuntimeStatus(statusByEnvironmentId.get(parsed.environmentId))
      return [
        {
          hostId: parsed.id,
          environmentId: parsed.environmentId,
          identity: { pairingRevision: identity.pairingRevision, runtimeId: identity.runtimeId },
          label: entry.label,
          health: entry.health,
          relay: relayVerdict(entry.health, answer)
        }
      ]
    })
  }

  private refresh(host: DescribedHost): Promise<boolean> {
    const key = `${host.environmentId}\0${fenceOf(host.identity)}`
    const inFlight = this.refreshing.get(key)
    if (inFlight) {
      return inFlight
    }
    const refresh = this.fetchAsDesktop(host).finally(() => this.refreshing.delete(key))
    this.refreshing.set(key, refresh)
    return refresh
  }

  private async fetchAsDesktop(host: DescribedHost): Promise<boolean> {
    try {
      const response = await this.options.hosts.call(
        host,
        'worktree.ps',
        { limit: SERVER_WORKTREE_LIMIT, supportsWorktreeVisibilitySourceDefaults: true },
        // Why the transport bound too: it ends the hung call, so the next poll fetches afresh instead of joining it.
        { timeoutMs: SERVER_FETCH_TIMEOUT_MS, expected: host.identity }
      )
      const reply = response.ok ? WorktreePsReplySchema.safeParse(response.result) : null
      if (!reply?.success) {
        return false
      }
      this.cached.set(host.environmentId, {
        // Why the identity taken before the fetch: the call's own check cannot see a re-pair after dispatch.
        fence: fenceOf(host.identity),
        fetchedAt: (this.options.now ?? Date.now)(),
        worktrees: stampServerWorktreeRows(host.environmentId, reply.data.worktrees),
        totalCount: reply.data.totalCount,
        truncated: reply.data.truncated
      })
      return true
    } catch {
      // An unreachable server keeps its last rows; they are served as stale.
      return false
    }
  }
}

function fenceOf(identity: DescribedHost['identity']): string {
  return `${identity.pairingRevision}\0${identity.runtimeId}`
}

/** False once the bound passes; the call's own timeout starts only after the desktop's per-server queue. */
async function withinFetchBound(refresh: Promise<boolean>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), SERVER_FETCH_TIMEOUT_MS)
  })
  try {
    return await Promise.race([refresh, bound])
  } finally {
    clearTimeout(timer)
  }
}

function relayVerdict(
  health: MobileRelayHost['health'],
  answer: RuntimeStatus | null
): MobileRelayHostRelay {
  if (!answer) {
    return 'unavailable'
  }
  // Why: a build's capabilities do not expire, so an old server stays update-needed while offline.
  if (!(answer.capabilities ?? []).includes(DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY)) {
    return 'update-needed'
  }
  return health === 'available' ? 'ready' : 'unavailable'
}

/**
 * A server's rows name hosts relative to that server (`local`, its own `ssh:` targets). Like the
 * desktop sidebar, the phone shows every one of them under the server, so all become its host id.
 */
function stampServerWorktreeRows<Row extends { hostId?: string }>(
  environmentId: string,
  rows: readonly Row[]
): (Row & { hostId: `runtime:${string}` })[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return rows.map((row) => ({ ...row, hostId }))
}
