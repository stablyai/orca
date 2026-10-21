/**
 * Which execution host a destructive worktree removal runs against.
 *
 * `removeManagedWorktree` resolved its host once, for metadata pruning
 * (`cleanupHostId ?? getRepoExecutionHostId(repo)`), and then read raw `repo.connectionId` for
 * every step that actually touches the filesystem: the `git worktree list` that decides whether the
 * path is registered, the provider handed to the unregistered-removal branch, the
 * registered-remote-vs-local fork, and the PTY/history teardown. One function, two spellings —
 * so a row naming its owner only as `executionHostId: 'ssh:<target>'` listed a *remote* checkout on
 * this client, entered the unregistered branch with `provider: null`, and deleted a same-named
 * local directory while metadata was pruned under `ssh:<target>` (#11163). #18358 made that
 * reachable by migrating the cleanup scan, so those rows now surface as removable candidates.
 *
 * Routing is now one answer for the whole removal, taken from the host the prune already used, so
 * list, remove and prune cannot disagree. The ambiguous nullable SSH-provider carrier
 * is deleted from the callees rather than supplemented, which makes every remaining reader a
 * compile error in the typed modules that do the destructive work.
 *
 * `runtime:<env>` is not a variant. Its files live on that environment's own server and the SSH
 * target on its repo row is that server's nested one, addressable only as the pair
 * (environmentId, targetId); handing it to this client's SSH table would `git worktree remove` a
 * same-named path on the wrong machine. It throws, matching `workspace-cleanup-git-route` and
 * `runtime-git-command-target`.
 *
 * An `ssh:` host is not served here, so it throws too. Loss of contact is never evidence that
 * the checkout is local (docs/reference/ssh-execution-boundary.md); refusing leaves a remote
 * worktree in place, while the incumbent fallback deleted a client-side path.
 */

import {
  parseExecutionHostId,
  type ExecutionHostId,
  type LOCAL_EXECUTION_HOST_ID
} from '../shared/execution-host'
import {
  CLIENT_REMOVAL_HOME,
  executionHostRemovalHome,
  type WorktreeRemovalHomeAuthority
} from './worktree-removal-home-guard'
import {
  ExecutionHostNotDispatchableError,
  resolveGitRouteForHost
} from './providers/execution-host-provider-dispatch'
import { SshHostNotServedError } from './providers/ssh-host-not-served-error'

export type WorktreeRemovalRoute = { kind: 'local'; hostId: typeof LOCAL_EXECUTION_HOST_ID }

export function resolveWorktreeRemovalRoute(hostId: ExecutionHostId): WorktreeRemovalRoute {
  const route = resolveGitRouteForHost(hostId)
  switch (route.kind) {
    case 'local':
      return { kind: 'local', hostId: route.hostId }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
    case 'ssh':
      throw new SshHostNotServedError(route.connectionId)
  }
}

/**
 * Whose home directory the removal's safety guards may consult — one answer for
 * the whole removal, taken from the same host id that owns the filesystem.
 */
export function resolveWorktreeRemovalHome(
  route: WorktreeRemovalRoute
): WorktreeRemovalHomeAuthority {
  return resolveWorktreeRemovalHomeForHost(route.hostId)
}

/**
 * The same answer for the entry points that hold a host id rather than a route.
 *
 * Keyed on the resolved `ExecutionHostId`, not on `repo.connectionId`: a row naming its owner only
 * as `executionHostId: 'ssh:<target>'` has a null `connectionId`, and answering that with this
 * client's home is how the guard would vouch for the wrong machine (#11163).
 */
export function resolveWorktreeRemovalHomeForHost(
  hostId: ExecutionHostId
): WorktreeRemovalHomeAuthority {
  const parsed = parseExecutionHostId(hostId)
  switch (parsed?.kind) {
    case 'local':
      return CLIENT_REMOVAL_HOME
    // Why spelled out rather than a `default`: no other host's home is known here, and this
    // client's home vouches for nothing on it — a host kind added later has to come here and say.
    case 'ssh':
    case 'runtime':
    case undefined:
      return executionHostRemovalHome(null)
  }
}
