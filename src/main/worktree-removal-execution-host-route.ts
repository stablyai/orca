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
 * list, remove and prune cannot disagree. The ambiguous `provider: SshGitProvider | null` carrier
 * is deleted from the callees rather than supplemented, which makes every remaining reader a
 * compile error in the typed modules that do the destructive work.
 *
 * `runtime:<env>` is not a variant. Its files live on that environment's own server and the SSH
 * target on its repo row is that server's nested one, addressable only as the pair
 * (environmentId, targetId); handing it to this client's SSH table would `git worktree remove` a
 * same-named path on the wrong machine. It throws, matching `workspace-cleanup-git-route` and
 * `runtime-git-command-target`.
 *
 * An `ssh:` host with no registered provider also throws. Loss of contact is never evidence that
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
  resolveFilesystemRouteForHost,
  resolveGitRouteForHost
} from './providers/execution-host-provider-dispatch'
import { SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from './providers/ssh-git-dispatch'
import type { SshGitProvider } from './providers/ssh-git-provider'
import type { IFilesystemProvider } from './providers/types'

export type WorktreeRemovalRoute =
  | { kind: 'local'; hostId: typeof LOCAL_EXECUTION_HOST_ID }
  | {
      kind: 'ssh'
      hostId: `ssh:${string}`
      connectionId: string
      provider: SshGitProvider
      /**
       * Still nullable: the incumbent read `getSshFilesystemProvider` (not `require…`) and the
       * directory branches raise their own message when they need it. Narrowing it here would
       * refuse removals that never touch the filesystem provider.
       */
      fsProvider: IFilesystemProvider | null
    }

export function resolveWorktreeRemovalRoute(hostId: ExecutionHostId): WorktreeRemovalRoute {
  const route = resolveGitRouteForHost(hostId)
  switch (route.kind) {
    case 'local':
      return { kind: 'local', hostId: route.hostId }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
    case 'ssh': {
      if (!route.provider) {
        throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      const fsRoute = resolveFilesystemRouteForHost(hostId)
      return {
        kind: 'ssh',
        hostId: route.hostId,
        connectionId: route.connectionId,
        provider: route.provider,
        fsProvider: fsRoute.kind === 'ssh' ? fsRoute.provider : null
      }
    }
  }
}

/**
 * Reads the `$HOME` an active SSH session resolved on its host.
 *
 * Injected the same way `setSshActiveMultiplexerResolver` is, because importing
 * the session table here would run its registration inside every suite that
 * partially mocks the SSH registry. Unresolved stays `null` — "unknown", never
 * "this client's home".
 */
let sshHostHomeResolver: (connectionId: string) => string | null = () => null

export function setWorktreeRemovalSshHostHomeResolver(
  resolver: (connectionId: string) => string | null
): void {
  sshHostHomeResolver = resolver
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
    case 'ssh':
      return executionHostRemovalHome(sshHostHomeResolver(parsed.targetId))
    // Why spelled out rather than a `default`: `runtime:<env>` deletes on that environment's own
    // server and an id that parses to nothing names no machine at all, so neither can be answered
    // with this client's home — and a host kind added later has to come here and say which it is.
    case 'runtime':
    case undefined:
      return executionHostRemovalHome(null)
  }
}

/** The connection to teardown PTYs, watchers and history against — `undefined` on a local host. */
export function getWorktreeRemovalConnectionId(route: WorktreeRemovalRoute): string | undefined {
  return route.kind === 'ssh' ? route.connectionId : undefined
}
