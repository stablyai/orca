import { useHostQuery } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import {
  HOST_LIST_TARGET,
  hostServerWorkspacesInput,
  hostServerWorkspacesQuery,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/catalog/host-list-queries'
import { relaysToServers } from '../worktree/execution-hosts/execution-host-scoped-rpc-client'

type WorktreeRow = Pick<Worktree, 'path' | 'repoId' | 'branch' | 'lastActivityAt' | 'isArchived'>

const NO_ROWS: readonly WorktreeRow[] = []

// The host list's catalog: the drawer shows it at once when this document already read it.
export function useHostWorktreeRows(
  client: RpcClient | null,
  connected: boolean,
  hostId: string
): readonly WorktreeRow[] {
  const { data } = useHostQuery(
    hostWorktreeCatalogQuery,
    { hostId, client: connected ? client : null },
    HOST_LIST_TARGET,
    NO_HOST_LIST_INPUT
  )
  return data?.worktrees ?? NO_ROWS
}

// The rows of the servers this desktop relays to, which the desktop's own catalog leaves out.
export function useHostServerWorktreeRows(
  client: RpcClient | null,
  connected: boolean,
  hostId: string,
  hostCapabilities: readonly string[]
): readonly WorktreeRow[] {
  const { data } = useHostQuery(
    hostServerWorkspacesQuery,
    { hostId, client: connected ? client : null },
    HOST_LIST_TARGET,
    hostServerWorkspacesInput(hostCapabilities),
    { enabled: connected && client !== null && relaysToServers(client, hostCapabilities) }
  )
  return data?.worktrees ?? NO_ROWS
}
