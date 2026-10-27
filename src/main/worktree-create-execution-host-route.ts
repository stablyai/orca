/** Resolve the filesystem owner consistently for IPC and runtime creates. */

import { getRepoExecutionHostId, type LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import type { Repo } from '../shared/repo-types'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from './providers/execution-host-provider-dispatch'

export type WorktreeCreateRoute =
  | { kind: 'local'; hostId: typeof LOCAL_EXECUTION_HOST_ID }
  | { kind: 'ssh'; hostId: `ssh:${string}`; connectionId: string }
  | { kind: 'runtime'; hostId: `runtime:${string}`; environmentId: string }

export function resolveWorktreeCreateRoute(repo: Repo): WorktreeCreateRoute {
  const route = resolveGitRouteForHost(getRepoExecutionHostId(repo))
  switch (route.kind) {
    case 'local':
      return { kind: 'local', hostId: route.hostId }
    case 'ssh':
      return { kind: 'ssh', hostId: route.hostId, connectionId: route.connectionId }
    case 'runtime':
      return { kind: 'runtime', hostId: route.hostId, environmentId: route.environmentId }
  }
}

/** Runtime SSH targets belong to the server's namespace; the client must not resolve them locally. */
export function requireWorktreeCreateRoute(
  repo: Repo
): Exclude<WorktreeCreateRoute, { kind: 'runtime' }> {
  const route = resolveWorktreeCreateRoute(repo)
  if (route.kind === 'runtime') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route
}
