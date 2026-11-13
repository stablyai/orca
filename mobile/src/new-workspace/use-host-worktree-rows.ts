import { useHostQuery } from '../query/host-query'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  HOST_LIST_TARGET,
  hostWorktreeCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../host-screen/catalog/host-list-queries'

type WorktreeRow = Pick<Worktree, 'path' | 'repoId' | 'branch'>

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
