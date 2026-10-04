import type { ExecutionHostId } from '../../shared/execution-host'
export { getStoredRepoExecutionHostId as getRepoHostedReviewExecutionHostId } from '../repo-execution-host'
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
