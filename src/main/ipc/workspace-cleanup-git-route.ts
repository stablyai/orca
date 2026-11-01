/** Route by execution host; unreachable SSH must never fall back to local paths.
 * Runtime targets belong to their server's nested namespace and cannot use this client's SSH registry. */

import {
  getRepoExecutionHostId,
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import type { Worktree } from '../../shared/worktree/types'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from '../providers/execution-host-provider-dispatch'

export type WorkspaceCleanupGitRoute =
  | { kind: 'local'; hostId: typeof LOCAL_EXECUTION_HOST_ID }
  /** SSH is unreachable from this process, never a local fallback. */
  | { kind: 'ssh'; hostId: `ssh:${string}`; connectionId: string }

/** Refuse listing/metadata host disagreement rather than reading one host while labeling another. */
export type WorkspaceCleanupWorktreeGitRoute =
  | WorkspaceCleanupGitRoute
  | { kind: 'host-mismatch'; hostId: ExecutionHostId; listedHostId: ExecutionHostId }

/** Runtime rows belong to their server; callers report this refusal as a repo scan error. */
export function resolveWorkspaceCleanupRepoGitRoute(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): WorkspaceCleanupGitRoute {
  const route = resolveGitRouteForHost(getRepoExecutionHostId(repo))
  switch (route.kind) {
    case 'local':
      return { kind: 'local', hostId: route.hostId }
    case 'ssh':
      return {
        kind: 'ssh',
        hostId: route.hostId,
        connectionId: route.connectionId
      }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}

export function resolveWorkspaceCleanupWorktreeGitRoute(
  repoRoute: WorkspaceCleanupGitRoute,
  worktree: Pick<Worktree, 'hostId'>,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): WorkspaceCleanupWorktreeGitRoute {
  const hostId = getWorktreeExecutionHostId(worktree, repo)
  return hostId === repoRoute.hostId
    ? repoRoute
    : { kind: 'host-mismatch', hostId, listedHostId: repoRoute.hostId }
}

export function isRemoteWorkspaceCleanupHost(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): boolean {
  return getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
}
