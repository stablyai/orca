import { parseExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import {
  routeRpcClientCalls,
  scopeRpcClientToExecutionHost
} from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'

type RoutedRepo = { id: string; executionHostId?: ExecutionHostId | null }

export function taskRepoServer(repo: RoutedRepo | undefined): ExecutionHostId | undefined {
  const host = repo?.executionHostId ? parseExecutionHostId(repo.executionHostId) : null
  return host?.kind === 'runtime' ? host.id : undefined
}

function selectedRepoId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('repo' in params)) {
    return undefined
  }
  return typeof params.repo === 'string' && params.repo.startsWith('id:')
    ? params.repo.slice('id:'.length)
    : undefined
}

// Route id-selected repos to their owning server; unlisted ids remain desktop-owned until listing resolves.
export function routeTaskRepoCalls(
  client: RpcClient,
  repos: () => readonly RoutedRepo[]
): RpcClient {
  return routeRpcClientCalls(client, (params) => {
    const repoId = selectedRepoId(params)
    return repoId === undefined
      ? undefined
      : taskRepoServer(repos().find((repo) => repo.id === repoId))
  })
}

export function taskRepoClient(client: RpcClient, repo: RoutedRepo): RpcClient {
  const server = taskRepoServer(repo)
  return server ? scopeRpcClientToExecutionHost(client, server) : client
}
