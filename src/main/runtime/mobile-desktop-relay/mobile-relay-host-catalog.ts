import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type {
  MobileRelayHostsListResult,
  MobileRelayHostWorktreesResult,
  MobileRelayServerWorktreeRow
} from '../../../shared/mobile-relay-hosts-contract'
import {
  getPairedDeviceIdsByEnvironment,
  isWorkspaceOwnedBySomeoneElse
} from '../../../shared/workspace-creator-visibility'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { getWorkspaceSessionTabActivityIds } from '../../../shared/workspace-session-tab-activity'
import { worktreeIdentityKey } from '../../../shared/worktree/id'
import { SERVER_FETCH_TIMEOUT_MS } from './server-worktree-fetch'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { describeRelayHosts, relayHostFence } from './mobile-relay-host-descriptions'

/** Sidebar live rows or per-phone-request fetches, always read as the desktop. */
export type ServerWorktreeRows = {
  sync: () => void
  /** Fetch now or join the in-flight fetch. */
  refresh: (environmentId: string) => Promise<void>
  /** Last-fetched rows under this pairing; null before a successful fetch. */
  rows: (environmentId: string, fence: string) => readonly MobileRelayServerWorktreeRow[] | null
}

/** Desktop-known health and workspace rows remain listable for offline/old servers; never inspect relayed replies. */
export class MobileRelayHostCatalog {
  constructor(
    private readonly options: {
      hosts: MobileDesktopRelayHosts
      serverRows: ServerWorktreeRows
      hostLabelOverrides: () => ReadonlyMap<ExecutionHostId, string>
      getWorkspaceSession: (hostId: ExecutionHostId) => WorkspaceSessionState | null
    }
  ) {}

  list(): MobileRelayHostsListResult {
    return {
      hosts: describeRelayHosts(this.options.hosts, this.options.hostLabelOverrides()).map(
        ({ hostId, label, health, relay }) => ({ hostId, label, health, relay })
      )
    }
  }

  async worktrees(hostId: string): Promise<MobileRelayHostWorktreesResult> {
    const parsed = parseExecutionHostId(hostId)
    // Re-pairing since status publication must fetch under the new identity.
    this.options.serverRows.sync()
    const host =
      parsed?.kind === 'runtime'
        ? describeRelayHosts(this.options.hosts).find(
            (entry) => entry.environmentId === parsed.environmentId
          )
        : undefined
    if (!host) {
      return { worktrees: null }
    }
    if (host.health === 'available') {
      await withinFetchBound(this.options.serverRows.refresh(host.environmentId))
    }
    const { environments, statusByEnvironmentId } = this.options.hosts.list()
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
    // Only desktop reads request background-removal support.
    return {
      worktrees: rows
        .filter((row) => row.removing !== true)
        .map((row) =>
          stampDesktopSidebarView(row, host.environmentId, desktopDeviceIds, sessionActivity)
        )
    }
  }
}

/** Bound waiting even while the call sits in the desktop queue, before its own timeout starts. */
async function withinFetchBound(refresh: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, SERVER_FETCH_TIMEOUT_MS)
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
