import { useContext, useMemo } from 'react'
import { MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY } from '../../../../src/shared/mobile-desktop-relay-contract'
import { useOptionalHostProtocolGates } from '../../components/host-protocol-gates-context'
import {
  HOST_LIST_POLL_MS,
  HOST_LIST_TARGET,
  hostServerWorkspacesQuery,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../../host-screen/host-list-queries'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { useHostQuery } from '../../query/host-query'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import { relaysToServers } from '../../worktree/execution-host-scoped-rpc-client'
import type { MobileLineageStores } from '../../worktree/mobile-workspace-lineage'
import { WorkspaceServerContext } from '../../worktree/workspace-server-context'
import type { Worktree } from '../../worktree/workspace-list-types'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { MobileRelayHost } from '../../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import {
  findFolderWorkspaceRow,
  getFolderAttachedWorktrees
} from './mobile-folder-attached-worktrees'

const NO_CAPABILITIES: readonly string[] = []
const NO_SERVER_HOSTS: readonly MobileRelayHost[] = []

export type MobileFolderAttachedWorktrees = {
  /** Undefined until the host's list is read; null when the list has no such folder. */
  folder: Worktree | null | undefined
  worktrees: Worktree[]
  desktopCapabilities: readonly string[]
  /** The servers the desktop relays to, for rows it can't open. */
  serverHosts: readonly MobileRelayHost[]
  connState: ConnectionState
  /** The first catalog read's failure, while nothing is shown. */
  loadError: Error | null
  refetch: () => void
}

/** The folder's attached worktrees from the host list's own reads, so the list and this screen agree. */
export function useMobileFolderAttachedWorktrees(
  hostId: string,
  folderWorktreeId: string,
  subscribed: boolean
): MobileFolderAttachedWorktrees {
  // The desktop lists every row, a relayed server's included, so read through it even on a server route.
  const { client, state } = useHostClient(hostId)
  const executionHost = useWorkspaceExecutionHost()
  const server = useContext(WorkspaceServerContext)
  const contextGates = useOptionalHostProtocolGates()
  // In a server's scope the gates in context are the server's; the desktop's travel with it.
  const desktopGates = server ? (server.desktopGates ?? null) : contextGates
  const desktopCapabilities = desktopGates?.hostCapabilities ?? NO_CAPABILITIES
  const ownInstallationId = desktopGates?.hostInstallationId
  const host = { hostId, client: state === 'connected' ? client : null }
  const catalog = useHostQuery(
    hostWorktreeCatalogQuery,
    host,
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT,
    { subscribed }
  )
  const relays = client !== null && relaysToServers(client, desktopCapabilities)
  const servers = useHostQuery(
    hostServerWorkspacesQuery,
    host,
    HOST_LIST_TARGET,
    { deltas: desktopCapabilities.includes(MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY) },
    // Execution hosts' notices are not relayed, so server rows keep the host list's poll.
    { enabled: relays, subscribed, refetchInterval: HOST_LIST_POLL_MS }
  )
  const ownRows = catalog.data?.worktrees
  const serverRows = servers.data?.worktrees
  const serverHosts = servers.data?.hosts
  const resolved = useMemo(() => {
    // A server's folder is unknown, not missing, until its rows are read.
    if (!ownRows || (executionHost && relays && !serverRows)) {
      return { folder: undefined, worktrees: [] }
    }
    const rows = [...ownRows, ...(serverRows ?? [])]
    const folder = findFolderWorkspaceRow(rows, folderWorktreeId, executionHost)
    const stores: MobileLineageStores = { ownInstallationId, servers: serverHosts ?? [] }
    return {
      folder: folder ?? null,
      worktrees: folder ? getFolderAttachedWorktrees(rows, folder, stores) : []
    }
  }, [ownRows, serverRows, serverHosts, folderWorktreeId, executionHost, ownInstallationId, relays])
  const refetchCatalog = catalog.refetch
  const refetchServers = servers.refetch
  return {
    ...resolved,
    desktopCapabilities,
    serverHosts: serverHosts ?? NO_SERVER_HOSTS,
    connState: state,
    loadError: ownRows ? null : catalog.error,
    refetch: () => {
      void refetchCatalog()
      if (relays) {
        void refetchServers()
      }
    }
  }
}
