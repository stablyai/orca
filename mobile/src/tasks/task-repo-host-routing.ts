import { parseExecutionHostId, type ExecutionHostId } from '../../../src/shared/execution-host'
import {
  routeRpcClientCalls,
  scopeRpcClientToExecutionHost
} from '../transport/execution-host-scoped-rpc-client'
import type { RpcClient } from '../transport/rpc-client'

type RoutedRepo = { id: string; executionHostId?: ExecutionHostId | null }

/** The one per-repo resolver: the server a repo runs on, undefined for the desktop's own. */
export function taskRepoServer(repo: RoutedRepo | undefined): ExecutionHostId | undefined {
  const host = repo?.executionHostId ? parseExecutionHostId(repo.executionHostId) : null
  return host?.kind === 'runtime' ? host.id : undefined
}

/** The repo a call names through the runtime's repo selector, `repo: 'id:<repoId>'`. */
function selectedRepoId(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null || !('repo' in params)) {
    return undefined
  }
  return typeof params.repo === 'string' && params.repo.startsWith('id:')
    ? params.repo.slice('id:'.length)
    : undefined
}

/**
 * The Tasks screen's client: a call naming a server's repo runs on that server, as the desktop
 * sends a repo's calls to its owner. It covers only calls that select a repo with `repo: 'id:…'`;
 * the rest take `taskRepoClient`. An id not listed stays on the desktop: it is the desktop's repo,
 * or one selected before the list loaded. Ids are bare, as the desktop's task selection is.
 */
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

/** The client for a repo's calls that select no repo, such as agent detection on its host. */
export function taskRepoClient(client: RpcClient, repo: RoutedRepo): RpcClient {
  const server = taskRepoServer(repo)
  return server ? scopeRpcClientToExecutionHost(client, server) : client
}
