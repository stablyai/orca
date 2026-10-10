/**
 * Which execution host a cleanup scan reads Git from.
 *
 * The family used to thread `provider: IGitProvider | null` derived from a raw `repo.connectionId`
 * read. That `null` spelled "this is local", "the host is remote but unreachable" and "the host is
 * a runtime environment" with one value, so a row naming its owner only as
 * `executionHostId: 'ssh:<target>'` listed, statted and `git status`-ed a *remote* path on this
 * client — the #11163 defect class. The `provider!` assertions in `workspace-cleanup-git-evidence`
 * were sound only because they re-read that same field, which is why the two moved together.
 *
 * `runtime:<env>` is deliberately not a variant. Its Git is executed by that environment's own
 * server, and the SSH target on its repo row is that server's *nested* one, addressable only as the
 * pair (environmentId, targetId). Handing it to this client's SSH table dials a same-named target
 * in the wrong namespace, so it throws rather than routing — the same refusal
 * `workspace-space-repo-scan` and `runtime-git-command-target` already make.
 */

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
import type { SshGitProvider } from '../providers/ssh-git-provider'

export type WorkspaceCleanupGitRoute =
  | { kind: 'local'; hostId: typeof LOCAL_EXECUTION_HOST_ID }
  /** `provider: null` is "remote and currently unreachable" — never "read it here". */
  | { kind: 'ssh'; hostId: `ssh:${string}`; connectionId: string; provider: SshGitProvider | null }

/**
 * The workspace's own host is the authority, and it can disagree with the row that produced the
 * listing (legacy unqualified metadata on a repo id that has since moved hosts). Reading one host
 * while the candidate reports the other is the cross-host leak, so the disagreement is its own
 * answer and the scan refuses instead of guessing.
 */
export type WorkspaceCleanupWorktreeGitRoute =
  | WorkspaceCleanupGitRoute
  | { kind: 'host-mismatch'; hostId: ExecutionHostId; listedHostId: ExecutionHostId }

/** Throws on a `runtime:` row; callers scan per repo and report the throw as a repo scan error. */
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
        connectionId: route.connectionId,
        provider: route.provider
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

/** True for every host whose files this client cannot stat directly. */
export function isRemoteWorkspaceCleanupHost(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): boolean {
  return getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID
}
