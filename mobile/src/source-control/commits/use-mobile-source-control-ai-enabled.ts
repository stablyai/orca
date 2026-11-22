import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../src/shared/execution-host/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../src/shared/worktree/id'
import { normalizeRepoSourceControlAiOverrides } from '../../../../src/shared/source-control/ai/settings/source-control-ai-repo-settings'
import { useHostQuery } from '../../query/host-query'
import {
  hostRepoCatalogQuery,
  NO_HOST_LIST_INPUT
} from '../../host-screen/catalog/host-list-queries'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { ConnectionState } from '../../transport/connection/connection-state'

// A relayed server's repo changes are not signalled to the phone, so its read holds no event stream.
const relayedRepoCatalogQuery = { ...hostRepoCatalogQuery, signal: undefined }

/** Desktop's Source Control AI switch for this worktree: the repo's override, else the host's setting. */
export function useMobileSourceControlAiEnabled(args: {
  hostId: string
  client: RpcClient | null
  connState: ConnectionState
  worktreeId: string
  executionHost: ExecutionHostId | undefined
  hostEnabled: boolean
}): boolean {
  const { hostId, client, connState, worktreeId, executionHost, hostEnabled } = args
  const exec = executionHost ?? LOCAL_EXECUTION_HOST_ID
  const { data: repos } = useHostQuery(
    exec === LOCAL_EXECUTION_HOST_ID ? hostRepoCatalogQuery : relayedRepoCatalogQuery,
    { hostId, client },
    { exec },
    NO_HOST_LIST_INPUT,
    { enabled: connState === 'connected' }
  )
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  const twins = repos?.catalog.filter((candidate) => candidate.id === repoId) ?? []
  // The same repo id can live on several hosts; prefer this route's host, else stay on the host switch.
  const repo =
    twins.length === 1
      ? twins[0]
      : twins.find((candidate) => getRepoExecutionHostId(candidate) === exec)
  const repoOverride = repo && 'sourceControlAi' in repo ? repo.sourceControlAi : undefined
  return normalizeRepoSourceControlAiOverrides(repoOverride)?.enabled ?? hostEnabled
}
