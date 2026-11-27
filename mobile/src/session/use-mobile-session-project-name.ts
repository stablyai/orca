import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../src/shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import { useHostQuery } from '../query/host-query'
import {
  hostRepoCatalogQuery,
  NO_HOST_LIST_INPUT,
  relayedHostRepoCatalogQuery
} from '../host-screen/catalog/host-list-queries'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../transport/connection/connection-state'

/** The workspace's project name from the host's repo list; worktree records don't carry it. */
export function useMobileSessionProjectName(args: {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  executionHost: string | null
}): string | null {
  const { hostId, client, connState, worktreeId, executionHost } = args
  const exec = normalizeExecutionHostId(executionHost) ?? LOCAL_EXECUTION_HOST_ID
  const { data: repos } = useHostQuery(
    exec === LOCAL_EXECUTION_HOST_ID ? hostRepoCatalogQuery : relayedHostRepoCatalogQuery,
    { hostId, client },
    { exec },
    NO_HOST_LIST_INPUT,
    { enabled: connState === 'connected' }
  )
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const twins = repos?.catalog.filter((candidate) => candidate.id === repoId) ?? []
  // The same repo id can live on several hosts; prefer this route's host.
  const repo =
    twins.length === 1
      ? twins[0]
      : twins.find((candidate) => getRepoExecutionHostId(candidate) === exec)
  return repo?.displayName?.trim() || null
}
