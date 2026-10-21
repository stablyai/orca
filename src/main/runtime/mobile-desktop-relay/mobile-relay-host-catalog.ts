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

/** Where the catalog reads each server's rows: main's live set, or a fetch per phone request. */
export type ServerWorktreeRows = {
  /** Catches up with the configured servers before a read. */
  sync: () => void
  /** Fetches now, or joins the fetch in flight. */
  refresh: (environmentId: string) => Promise<void>
  /** The server's rows as last fetched under this pairing; null when none were. */
  rows: (environmentId: string, fence: string) => readonly MobileRelayServerWorktreeRow[] | null
}

/**
 * The configured servers the desktop shows, for the phone: health from the desktop's own status
 * (the sidebar's mapping), and each server's workspace list as the desktop itself last fetched it,
 * so a server that is offline or too old to relay to still lists. Replies relayed to a phone are
 * never read here.
 */
export class MobileRelayHostCatalog {
  constructor(
    private readonly options: {
      hosts: MobileDesktopRelayHosts
      /** This catalog keeps no copy of the rows. */
      serverRows: ServerWorktreeRows
      hostLabelOverrides: () => ReadonlyMap<ExecutionHostId, string>
      /** The desktop's saved session for a host, as its sidebar last wrote it. */
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
    // Why sync first: a re-pair since the last status publication must fetch under the new pairing.
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
    // Why the identity read after the fetch: one answered after a re-pair stored the old server's rows.
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
    // Why: the desktop asks with background-removal support; a phone asking itself never sees these rows.
    return {
      worktrees: rows
        .filter((row) => row.removing !== true)
        .map((row) =>
          stampDesktopSidebarView(row, host.environmentId, desktopDeviceIds, sessionActivity)
        )
    }
  }
}

/** Settles once the bound passes; the call's own timeout starts only after the desktop's per-server queue. */
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

/**
 * What the desktop's own sidebar knows and the server cannot: which rows are another client's
 * (marked, not dropped; the phone applies the shared filter), and its browser and chat tabs as activity.
 */
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
