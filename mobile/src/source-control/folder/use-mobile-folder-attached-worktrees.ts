import { useContext, useMemo, useState } from 'react'
import { replaceEqualDeep } from '@tanstack/react-query'
import { MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY } from '../../../../src/shared/mobile-desktop-relay-contract'
import { useOptionalHostProtocolGates } from '../../components/host-protocol-gates-context'
import {
  HOST_LIST_POLL_MS,
  HOST_LIST_TARGET,
  hostServerWorkspacesQuery,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../../host-screen/catalog/host-list-queries'
import { useWorkspaceExecutionHost } from '../../navigation/workspace-execution-host'
import { useHostQuery } from '../../query/host-query'
import { useHostClient } from '../../transport/connection/host-client-hooks'
import { relaysToServers } from '../../worktree/execution-host-scoped-rpc-client'
import type { MobileLineageStores } from '../../worktree/mobile-workspace-lineage'
import { WorkspaceServerContext } from '../../worktree/workspace-server-context'
import type { ConnectionState } from '../../transport/connection/connection-state'
import type { MobileRelayHost } from '../../../../src/shared/remote-runtime/relay/mobile-relay-hosts-contract'
import {
  findFolderWorkspaceRow,
  folderLineageKey,
  getFolderAttachedWorktrees,
  toFolderListRow,
  type FolderListRow
} from './mobile-folder-attached-worktrees'
import type { Worktree } from '../../worktree/workspace-list-types'

type FolderLineage = {
  /** The catalog rows last seen. */
  source: readonly Worktree[]
  /** The rows membership was resolved over; same lineage keys as `source`, in the same order. */
  rows: readonly Worktree[]
  keys: readonly string[]
}

const NO_ROWS: FolderListRow[] = []

// Reads each row's cached key: only rows the catalog replaced are keyed again.
function sameLineage(held: FolderLineage | null, rows: readonly Worktree[]): held is FolderLineage {
  if (!held || held.keys.length !== rows.length) {
    return false
  }
  return rows.every((row, index) => folderLineageKey(row) === held.keys[index])
}

const NO_CAPABILITIES: readonly string[] = []
const NO_SERVER_HOSTS: readonly MobileRelayHost[] = []

export type MobileFolderAttachedWorktrees = {
  /** Undefined until the host's list is read; null when the list has no such folder. */
  folder: FolderListRow | null | undefined
  worktrees: readonly FolderListRow[]
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
  const allRows = useMemo(
    () => ownRows && (serverRows?.length ? [...ownRows, ...serverRows] : ownRows),
    [ownRows, serverRows]
  )
  // Agent, terminal and label updates rewrite rows constantly; membership is resolved again only when lineage moves.
  const [lineage, setLineage] = useState<FolderLineage | null>(null)
  let held = lineage
  if (allRows && held?.source !== allRows) {
    held = sameLineage(held, allRows)
      ? { ...held, source: allRows }
      : { source: allRows, rows: allRows, keys: allRows.map(folderLineageKey) }
    setLineage(held)
  }
  const lineageRows = held?.rows
  const serverRowsRead = serverRows !== undefined
  // Health and relay state flip often; the resolver reads only each server's installation.
  const storesKey = JSON.stringify(
    serverHosts?.map((server) => [server.hostId, server.installationId]) ?? []
  )
  const [heldStores, setHeldStores] = useState<{ key: string; stores: MobileLineageStores } | null>(
    null
  )
  let stores = heldStores?.stores
  if (heldStores?.key !== storesKey || stores?.ownInstallationId !== ownInstallationId) {
    stores = { ownInstallationId, servers: serverHosts ?? NO_SERVER_HOSTS }
    setHeldStores({ key: storesKey, stores })
  }
  const membership = useMemo(() => {
    // A server's folder is unknown, not missing, until its rows are read.
    if (!lineageRows || (executionHost && relays && !serverRowsRead)) {
      return undefined
    }
    const folder = findFolderWorkspaceRow(lineageRows, folderWorktreeId, executionHost)
    if (!folder) {
      return null
    }
    const indexOf = new Map(lineageRows.map((row, index) => [row, index]))
    return {
      folderIndex: indexOf.get(folder)!,
      memberIndexes: getFolderAttachedWorktrees(lineageRows, folder, stores).map((row) =>
        indexOf.get(row)!
      )
    }
  }, [lineageRows, serverRowsRead, stores, folderWorktreeId, executionHost, relays])
  // Same lineage means same row order, so the current rows supply the labels shown.
  const currentRows = held?.source
  const shown = useMemo(
    () =>
      membership && currentRows
        ? {
            folder: toFolderListRow(currentRows[membership.folderIndex]),
            worktrees: membership.memberIndexes.map((index) => toFolderListRow(currentRows[index]))
          }
        : null,
    [membership, currentRows]
  )
  const [heldShown, setHeldShown] = useState({ from: shown, value: shown })
  let stableShown = heldShown.value
  if (heldShown.from !== shown) {
    stableShown = replaceEqualDeep(heldShown.value, shown)
    setHeldShown({ from: shown, value: stableShown })
  }
  const resolved =
    membership === undefined
      ? { folder: undefined, worktrees: NO_ROWS }
      : stableShown
        ? stableShown
        : { folder: null, worktrees: NO_ROWS }
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
