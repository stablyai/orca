import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../shared/execution-host'
import type { Repo } from '../../shared/repo-types'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from '../providers/execution-host-provider-dispatch'

/**
 * The SSH target *this* process may dial for a hosted review, or `null` when the work runs here.
 *
 * The hosted-review contract used to carry `connectionId: string | null`, where `null` spelled
 * "genuinely local", "runtime host" and "could not resolve" alike — so a row naming its owner only
 * as `executionHostId: ssh:<target>` ran `git status`, `git rev-parse` and the forge CLI against
 * this machine's copy of a remote path (#11163). Resolving the host first removes that collapse.
 *
 * `runtime:` throws rather than degrading: that environment's server runs its own git, and the SSH
 * target on its repo row is nested in that server's namespace, so dialing it here reaches a
 * same-named box of ours. Store-backed callers ask `getRepoHostedReviewExecutionHostId` first,
 * which is the "what may this client dial" question and never hands a `runtime:` id down.
 */
export function hostedReviewSshConnectionId(executionHostId: ExecutionHostId): string | null {
  const route = resolveGitRouteForHost(executionHostId)
  if (route.kind === 'runtime') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route.kind === 'ssh' ? route.connectionId : null
}

/**
 * The host this process may run a hosted review on for a row in *its own* store.
 *
 * `getSshTargetIdForExecutionHost` and not `getRepoSshConnectionId`: a `runtime:` stamp on a row in
 * this store is how a paired client addresses it, not a second machine holding the files. The
 * runtime registration controller only adopts that stamp onto a row with no `connectionId`
 * (`runtimeRepoMatchesExecutionHost` refuses to match an SSH row), so the checkout really is here
 * and this keeps the review that has always been created for it. A row whose files sit on an SSH
 * host keeps its own target — including one that carries only `executionHostId: ssh:…`.
 */
export function getRepoHostedReviewExecutionHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'>
): ExecutionHostId {
  const hostId = getRepoExecutionHostId(repo)
  return getSshTargetIdForExecutionHost(hostId) ? hostId : LOCAL_EXECUTION_HOST_ID
}
