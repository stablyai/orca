import { useContext, useMemo } from 'react'
import { MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY } from '../../../../src/shared/mobile-desktop-relay-contract'
import { useOptionalHostProtocolGates } from '../../components/host-protocol-gates-context'
import {
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
import {
  findFolderWorkspaceRow,
  getFolderAttachedWorktrees
} from './mobile-folder-attached-worktrees'

const NO_CAPABILITIES: readonly string[] = []

export type MobileFolderAttachedWorktrees = {
  /** Undefined until the host's list is read; null when the list has no such folder. */
  folder: Worktree | null | undefined
  worktrees: Worktree[]
  desktopCapabilities: readonly string[]
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
  const gates = useOptionalHostProtocolGates()
  // In a server's scope the gates in context are the server's; the desktop's identity is not known there.
  const desktopCapabilities =
    server?.desktopCapabilities ?? gates?.hostCapabilities ?? NO_CAPABILITIES
  const ownInstallationId = server ? undefined : gates?.hostInstallationId
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
    { enabled: relays, subscribed }
  )
  const ownRows = catalog.data?.worktrees
  const serverRows = servers.data?.worktrees
  const serverHosts = servers.data?.hosts
  const resolved = useMemo(() => {
    if (!ownRows) {
      return { folder: undefined, worktrees: [] }
    }
    const rows = [...ownRows, ...(serverRows ?? [])]
    const folder = findFolderWorkspaceRow(rows, folderWorktreeId, executionHost)
    const stores: MobileLineageStores = { ownInstallationId, servers: serverHosts ?? [] }
    return {
      folder: folder ?? null,
      worktrees: folder ? getFolderAttachedWorktrees(rows, folder, stores) : []
    }
  }, [ownRows, serverRows, serverHosts, folderWorktreeId, executionHost, ownInstallationId])
  const refetchCatalog = catalog.refetch
  const refetchServers = servers.refetch
  return {
    ...resolved,
    desktopCapabilities,
    refetch: () => {
      void refetchCatalog()
      if (relays) {
        void refetchServers()
      }
    }
  }
}
