import type { RecipeEnvironmentDescription } from '../../../shared/remote-runtime/ephemeral-vm-recipes/recipe-host-removal'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import type {
  MobileRelayHostsListResult,
  MobileRelayHostWorktreesResult,
  MobileRelayServerWorktreeRow
} from '../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { getPairedDeviceIdsByEnvironment } from '../../../shared/workspace-view/workspace-creator-visibility'
import { stampDesktopSidebarView, stampRecipeEnvironment } from './mobile-relay-row-stamping'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { getWorkspaceSessionTabActivityIds } from '../../../shared/workspace-session/workspace-session-tab-activity'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import { SERVER_FETCH_TIMEOUT_MS } from './server-worktree-fetch'
import { normalizePairedServerRow } from '../../../shared/sidebar-list/feed-facts/paired-server-rows'
import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayListing
} from './mobile-desktop-relay-hosts'
import {
  describeRelayHost,
  describeRelayHosts,
  relayHostFence,
  type DescribedRelayHost
} from './mobile-relay-host-descriptions'
import {
  RelayHostRowsAnnouncer,
  relayHostRowsSources,
  type RelayPhoneReader
} from './mobile-relay-host-rows-announcer'
import {
  RelayHostListAnnouncer,
  type RelayHostListAnnouncerSources
} from './mobile-relay-host-list-announcer'
import {
  isPendingVmCheckout,
  type PendingVmCheckoutIndex
} from '../../../shared/remote-runtime/ephemeral-vm-store/pending-vm-checkouts'

export type MobileRelayRecipeEnvironmentLookup = (
  hostId: string
) => ReadonlyMap<string, RecipeEnvironmentDescription>

/** Sidebar live rows or per-phone-request fetches, always read as the desktop. */
export type ServerWorktreeRows = {
  sync: (listing?: MobileDesktopRelayListing) => void | Promise<void>
  /** Fetch now or join the in-flight fetch; may return the post-fetch host listing it verified. */
  refresh: (
    environmentId: string,
    host?: DescribedRelayHost
  ) => Promise<MobileDesktopRelayListing | void>
  /** Last-fetched rows under this pairing; null before a successful fetch. */
  rows: (environmentId: string, fence: string) => readonly MobileRelayServerWorktreeRow[] | null
}

/** A paired server's workspace as the plugin host's active-workspace context needs it. */
export type PairedWorkspaceContext = {
  worktreeId: string
  path: string
  branch: string
  displayName: string
}

/** Below a plugin's 2 s readContext poll; a miss answers null instead of holding the call. */
export const PAIRED_WORKSPACE_CONTEXT_FETCH_TIMEOUT_MS = 1_500
/** A workspace the server does not list must not turn every poll into a worktree.ps. */
export const PAIRED_WORKSPACE_CONTEXT_MISS_REFETCH_MS = 10_000

/** Desktop-known health and workspace rows remain listable for offline/old servers; never inspect relayed replies. */
export class MobileRelayHostCatalog {
  constructor(
    private readonly options: {
      hosts: MobileDesktopRelayHosts
      serverRows: ServerWorktreeRows
      hostLabelOverrides: () => ReadonlyMap<ExecutionHostId, string>
      getWorkspaceSession: (hostId: ExecutionHostId) => WorkspaceSessionState | null
      recipeEnvironmentsFor?: MobileRelayRecipeEnvironmentLookup
      /** VM checkouts a desktop create has not adopted yet; the phone must not list them. */
      pendingVmCheckouts?: () => PendingVmCheckoutIndex
      now?: () => number
    }
  ) {}

  private readonly contextMissFetchedAt = new Map<string, number>()

  /**
   * The focused workspace on a paired server, from the rows the desktop already holds. Only a
   * cache miss on a reachable server fetches, bounded and at most once per miss window; anything
   * else answers null so the caller never waits on an unreachable host.
   */
  async workspaceContext(
    hostId: ExecutionHostId,
    worktreeId: string
  ): Promise<PairedWorkspaceContext | null> {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind !== 'runtime') {
      return null
    }
    const { environmentId } = parsed
    const initialListing = await this.options.hosts.list()
    await this.options.serverRows.sync(initialListing)
    const cached = this.cachedWorkspaceContext(initialListing, hostId, environmentId, worktreeId)
    if (cached !== undefined && cached !== null) {
      return cached
    }
    const host = describeRelayHost(initialListing, environmentId)
    if (host?.health !== 'available') {
      return null
    }
    const now = (this.options.now ?? Date.now)()
    const missKey = `${environmentId}\0${relayHostFence(host.identity)}\0${worktreeId}`
    const lastFetch = this.contextMissFetchedAt.get(missKey)
    if (lastFetch !== undefined && now - lastFetch < PAIRED_WORKSPACE_CONTEXT_MISS_REFETCH_MS) {
      return null
    }
    if (this.contextMissFetchedAt.size >= 64) {
      this.contextMissFetchedAt.clear()
    }
    this.contextMissFetchedAt.set(missKey, now)
    const refreshedListing = await withinFetchBound(
      this.options.serverRows.refresh(environmentId, host).catch(() => undefined),
      PAIRED_WORKSPACE_CONTEXT_FETCH_TIMEOUT_MS
    )
    const postListing = refreshedListing ?? (await this.options.hosts.list())
    const fetched =
      this.cachedWorkspaceContext(postListing, hostId, environmentId, worktreeId) ?? null
    if (fetched) {
      this.contextMissFetchedAt.delete(missKey)
    }
    return fetched
  }

  /** undefined: no rows under the current pairing; null: rows hold no such workspace. */
  private cachedWorkspaceContext(
    listing: MobileDesktopRelayListing,
    hostId: ExecutionHostId,
    environmentId: string,
    worktreeId: string
  ): PairedWorkspaceContext | null | undefined {
    const current = listing.environments.find((environment) => environment.id === environmentId)
    const rows = current
      ? this.options.serverRows.rows(environmentId, relayHostFence(current))
      : null
    if (!rows) {
      return undefined
    }
    const key = worktreeIdentityKey(worktreeId)
    const pending = this.options.pendingVmCheckouts?.()
    for (const raw of rows) {
      if (raw.removing === true || (pending && isPendingVmCheckout(pending, raw))) {
        continue
      }
      const row = normalizePairedServerRow(hostId, raw)
      if (row && (row.worktreeId === worktreeId || worktreeIdentityKey(row.worktreeId) === key)) {
        const displayName = [row.displayName, row.path].find((label) => label.trim().length > 0)
        return {
          worktreeId: row.worktreeId,
          path: row.path,
          branch: row.branch,
          displayName: displayName?.trim() ?? ''
        }
      }
    }
    return null
  }

  private announcer: RelayHostListAnnouncer | null = null

  async list(reader?: RelayPhoneReader): Promise<MobileRelayHostsListResult> {
    const result = await this.describe()
    this.announcer?.listed(result, reader)
    return result
  }

  /** Whether a phone can reach this server through the desktop now, without announcing a list. */
  async relayReady(hostId: ExecutionHostId): Promise<boolean> {
    return (await this.describe()).hosts.some(
      (host) => host.hostId === hostId && host.relay === 'ready'
    )
  }

  /** Calls `changed` whenever list() would answer differently, so phones need not poll it. */
  publishListChanges(sources: RelayHostListAnnouncerSources): () => void {
    const announcer = new RelayHostListAnnouncer(
      this.options.hosts,
      async () => await this.describe(),
      sources
    )
    this.announcer = announcer
    return () => {
      announcer.dispose()
      if (this.announcer === announcer) {
        this.announcer = null
      }
    }
  }

  private async describe(): Promise<MobileRelayHostsListResult> {
    return {
      hosts: (await describeRelayHosts(this.options.hosts, this.options.hostLabelOverrides())).map(
        ({
          hostId,
          label,
          health,
          relay,
          stoppedOnDesktop,
          unavailableOnDesktop,
          installationId,
          rowChanges
        }) => ({
          hostId,
          label,
          health,
          relay,
          ...(stoppedOnDesktop ? { stoppedOnDesktop } : {}),
          ...(unavailableOnDesktop ? { unavailableOnDesktop } : {}),
          ...(installationId ? { installationId } : {}),
          ...(rowChanges ? { rowChanges } : {})
        })
      )
    }
  }

  private rowsAnnouncer: RelayHostRowsAnnouncer | null = null

  /** Calls `changed` when a server a connected phone read has new agent rows, so phones need not poll them. */
  publishRowChanges(changed: (hostId: `runtime:${string}`) => void): () => void {
    const announcer = new RelayHostRowsAnnouncer(relayHostRowsSources(this.options.hosts), changed)
    this.rowsAnnouncer = announcer
    return () => announcer.dispose()
  }

  /** Releases all server row watches held by a phone connection that navigated away from row views. */
  releaseRowHolds(connectionId: string): void {
    this.rowsAnnouncer?.release(connectionId)
  }

  /** `by` is the phone connection reading, so the server stays watched for it. */
  async worktrees(hostId: string, by?: RelayPhoneReader): Promise<MobileRelayHostWorktreesResult> {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind !== 'runtime') {
      return { worktrees: null }
    }
    // One host listing serves sync and host lookup; re-pairing since status publication must fetch under the new identity.
    const initialListing = await this.options.hosts.list()
    await this.options.serverRows.sync(initialListing)
    const host = describeRelayHost(initialListing, parsed.environmentId)
    if (!host) {
      return { worktrees: null }
    }
    let postListing = initialListing
    if (host.health === 'available') {
      this.rowsAnnouncer?.hold(host, by)
      const refreshedListing = await withinFetchBound(
        this.options.serverRows.refresh(host.environmentId, host),
        SERVER_FETCH_TIMEOUT_MS
      )
      this.rowsAnnouncer?.refreshed(host.environmentId)
      postListing = refreshedListing ?? (await this.options.hosts.list())
    }
    const { environments, statusByEnvironmentId } = postListing
    const current = environments.find((environment) => environment.id === host.environmentId)
    // The request belongs to the pairing that admitted its fetch.
    if (!current || relayHostFence(current) !== relayHostFence(host.identity)) {
      return { worktrees: null }
    }
    const rows = this.options.serverRows.rows(host.environmentId, relayHostFence(current))
    if (!current || !rows) {
      return { worktrees: null }
    }
    const desktopDeviceIds = getPairedDeviceIdsByEnvironment([current], statusByEnvironmentId)
    const sessionActivity = new Set(
      [
        ...getWorkspaceSessionTabActivityIds(
          this.options.getWorkspaceSession(toRuntimeExecutionHostId(host.environmentId))
        )
      ].map(worktreeIdentityKey)
    )
    let recipeEnvironments: ReadonlyMap<string, RecipeEnvironmentDescription> | undefined
    try {
      recipeEnvironments = this.options.recipeEnvironmentsFor?.(
        toRuntimeExecutionHostId(host.environmentId)
      )
    } catch {
      // The tag only decorates rows; an unreadable VM store must not blank the phone's list.
      recipeEnvironments = undefined
    }
    const pending = this.options.pendingVmCheckouts?.()
    // Only desktop reads request background-removal support.
    return {
      worktrees: rows
        .filter((row) => row.removing !== true && !(pending && isPendingVmCheckout(pending, row)))
        .map((row) =>
          stampRecipeEnvironment(
            stampDesktopSidebarView(row, host.environmentId, desktopDeviceIds, sessionActivity),
            recipeEnvironments
          )
        )
    }
  }
}

/** Bound waiting even while the call sits in the desktop queue, before its own timeout starts. */
async function withinFetchBound<T>(refresh: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs)
  })
  try {
    return await Promise.race([refresh, bound])
  } finally {
    clearTimeout(timer)
  }
}
