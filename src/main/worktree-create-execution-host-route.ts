/**
 * Which execution host a worktree create runs on.
 *
 * Two entry points create the same workspace and disagreed about how to read its host. The runtime
 * path resolved (`workspaces/workspace-creation.ts`) and then normalized the row; the IPC
 * handler branched on raw `repo.connectionId`, so a row naming its owner only as
 * `executionHostId: 'ssh:<target>'` ran `git worktree add` on the client against a remote path
 * (#11163). Same repo, two entry points, two answers.
 *
 * Both now take this one route. An `ssh:` route is not served here: both entry points refuse it
 * with `SshHostNotServedError`, never by creating locally.
 */

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

/**
 * For the two create forks that put files on a host. `runtime:<env>` is not one of them: the
 * environment's own server creates the worktree, and the SSH target on its repo row is that
 * server's nested one, addressable only as (environmentId, targetId). Creating through this
 * client's SSH table would `git worktree add` on a same-named target on the wrong machine.
 */
export function requireWorktreeCreateRoute(
  repo: Repo
): Exclude<WorktreeCreateRoute, { kind: 'runtime' }> {
  const route = resolveWorktreeCreateRoute(repo)
  if (route.kind === 'runtime') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route
}
