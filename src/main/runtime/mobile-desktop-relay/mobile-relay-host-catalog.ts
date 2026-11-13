import type { RecipeEnvironmentDescription } from '../../../shared/recipe-host-removal'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type {
  MobileRelayHostsListResult,
  MobileRelayHostWorktreesResult,
  MobileRelayServerWorktreeRow
} from '../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import {
  getPairedDeviceIdsByEnvironment,
  isWorkspaceOwnedBySomeoneElse
} from '../../../shared/workspace-creator-visibility'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { getWorkspaceSessionTabActivityIds } from '../../../shared/workspace-session/workspace-session-tab-activity'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import { SERVER_FETCH_TIMEOUT_MS } from './server-worktree-fetch'
import { normalizePairedServerRow } from '../../../shared/sidebar-list/feed-facts/paired-server-rows'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { describeRelayHosts, relayHostFence } from './mobile-relay-host-descriptions'
import {
  RelayHostListAnnouncer,
  type RelayHostListAnnouncerSources
} from './mobile-relay-host-list-announcer'
import {
  isPendingVmCheckout,
  type PendingVmCheckoutIndex
} from '../../../shared/pending-vm-checkouts'

export type MobileRelayRecipeEnvironmentLookup = (
  hostId: string
) => ReadonlyMap<string, RecipeEnvironmentDescription>

/** Sidebar live rows or per-phone-request fetches, always read as the desktop. */
export type ServerWorktreeRows = {
  sync: () => void | Promise<void>
  /** Fetch now or join the in-flight fetch. */
  refresh: (environmentId: string) => Promise<void>
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
    await this.options.serverRows.sync()
    const cached = await this.cachedWorkspaceContext(hostId, environmentId, worktreeId)
    if (cached !== undefined && cached !== null) {
      return cached
    }
    const host = (await describeRelayHosts(this.options.hosts)).find(
      (entry) => entry.environmentId === environmentId
    )
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
    await withinFetchBound(
      this.options.serverRows.refresh(environmentId).catch(() => {}),
      PAIRED_WORKSPACE_CONTEXT_FETCH_TIMEOUT_MS
    )
    const fetched = (await this.cachedWorkspaceContext(hostId, environmentId, worktreeId)) ?? null
    if (fetched) {
      this.contextMissFetchedAt.delete(missKey)
    }
    return fetched
  }

  /** undefined: no rows under the current pairing; null: rows hold no such workspace. */
  private async cachedWorkspaceContext(
    hostId: ExecutionHostId,
    environmentId: string,
    worktreeId: string
  ): Promise<PairedWorkspaceContext | null | undefined> {
    const current = (await this.options.hosts.list()).environments.find(
      (environment) => environment.id === environmentId
    )
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

  async list(): Promise<MobileRelayHostsListResult> {
    const result = await this.describe()
    this.announcer?.listed(result)
    return result
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
          installationId
        }) => ({
          hostId,
          label,
          health,
          relay,
          ...(stoppedOnDesktop ? { stoppedOnDesktop } : {}),
          ...(unavailableOnDesktop ? { unavailableOnDesktop } : {}),
          ...(installationId ? { installationId } : {})
        })
      )
    }
  }

  async worktrees(hostId: string): Promise<MobileRelayHostWorktreesResult> {
    const parsed = parseExecutionHostId(hostId)
    // Re-pairing since status publication must fetch under the new identity.
    this.options.serverRows.sync()
    const host =
      parsed?.kind === 'runtime'
        ? (await describeRelayHosts(this.options.hosts)).find(
            (entry) => entry.environmentId === parsed.environmentId
          )
        : undefined
    if (!host) {
      return { worktrees: null }
    }
    if (host.health === 'available') {
      await withinFetchBound(
        this.options.serverRows.refresh(host.environmentId),
        SERVER_FETCH_TIMEOUT_MS
      )
    }
    const { environments, statusByEnvironmentId } = await this.options.hosts.list()
    const current = environments.find((environment) => environment.id === host.environmentId)
    // Re-pairing during fetch can leave old-server rows; recheck identity afterward.
    const rows = current
      ? this.options.serverRows.rows(host.environmentId, relayHostFence(current))
      : null
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

/** Only this desktop knows which workspaces live on VMs it created; the server's rows can't say. */
function stampRecipeEnvironment(
  row: MobileRelayServerWorktreeRow,
  recipeEnvironments: ReadonlyMap<string, RecipeEnvironmentDescription> | undefined
): MobileRelayServerWorktreeRow {
  const environment =
    typeof row.worktreeId === 'string' ? recipeEnvironments?.get(row.worktreeId) : undefined
  if (environment) {
    return { ...row, recipeEnvironment: environment }
  }
  // Only this desktop may say a row's VM is its own; drop the field if the server sent one.
  if ('recipeEnvironment' in row) {
    const { recipeEnvironment: _serverClaim, ...rest } = row
    return { ...rest, hostId: row.hostId }
  }
  return row
}

/** Bound waiting even while the call sits in the desktop queue, before its own timeout starts. */
async function withinFetchBound(refresh: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs)
  })
  try {
    return await Promise.race([refresh, bound])
  } finally {
    clearTimeout(timer)
  }
}

/** Stamp desktop-only knowledge: mark other-client rows without dropping them, and include browser/chat activity. */
function stampDesktopSidebarView(
  row: MobileRelayServerWorktreeRow,
  environmentId: string,
  desktopDeviceIds: ReadonlyMap<string, string>,
  sessionActivity: ReadonlySet<string>
): MobileRelayServerWorktreeRow {
  const otherClient = isWorkspaceOwnedBySomeoneElse(
    { creatorProvenance: row.creatorProvenance, runtimeOwnerEnvironmentId: environmentId },
    desktopDeviceIds
  )
  const active =
    typeof row.worktreeId === 'string' && sessionActivity.has(worktreeIdentityKey(row.worktreeId))
  if (!otherClient && !active) {
    return row
  }
  return {
    ...row,
    ...(otherClient ? { desktopOtherClient: true } : {}),
    ...(active ? { hasHostSidebarActivity: true } : {})
  }
}
