/**
 * Host-keyed provider dispatch: one entry per execution host kind, with `local` among them.
 *
 * The incumbent spelling across main is `const c = repo.connectionId; c ? sshProvider(c) : local()`,
 * where `null` means *both* "resolved: this is local" and "could not resolve". Every path that
 * cannot determine the host therefore answers "local" and runs remote work on the client — the
 * #11163 defect class, which has produced a reproduced cross-host leak (an `ssh:` worktree
 * resolving to another target) and near-misses where a transcript that exists only on a remote host
 * would have been read locally. The shape also cannot express a `runtime:` host at all.
 *
 * This module removes that spelling. Its input is an `ExecutionHostId`, which is never null, and an
 * id that names no host throws instead of degrading. `getRepoExecutionHostId` /
 * `getWorktreeExecutionHostId` / `resolveWorktreeExecutionHost` are the resolution layer that feeds
 * it; the last one already answers `unresolved` as a distinct verdict rather than "local".
 *
 * Why a route union rather than a uniform `getGitProviderForHost(): IGitProvider`:
 *
 *   - `local` git and filesystem work takes per-worktree execution options (`wslDistro`,
 *     `sharedLinkPaths`, admission tier). A registered stateless provider would silently drop WSL
 *     routing, so the local git and filesystem routes carry a factory that is built per call.
 *   - `runtime:<env>` is never executed in this process; it is forwarded to that server, which
 *     treats it as its own `local`. A runtime repo's `connectionId` names the *server's* SSH target,
 *     so handing it to this client's SSH table would dial a same-named target on the wrong host.
 *
 * So each host kind is its own variant and callers switch exhaustively; `runtime` cannot collapse
 * into `local` by omission.
 *
 * Inside the `ssh` variant, `provider: null` means "remote and currently unreachable", never
 * "local" — loss of contact is never evidence of locality (the `live` / `unverifiable` / `exited`
 * rule in AGENTS.md).
 */

import {
  parseExecutionHostId,
  type ExecutionHostId,
  type LOCAL_EXECUTION_HOST_ID,
  type ParsedExecutionHost
} from '../../shared/execution-host'
import { createLocalFilesystemProvider } from './local-filesystem-provider'
import { createLocalGitProvider } from './local-git-provider'
import { getSshGitProvider, sshGitProviderMissingError } from './ssh-git-dispatch'
import type { SshGitProvider } from './ssh-git-provider'
import {
  getSshFilesystemProvider,
  SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE
} from './ssh-filesystem-dispatch'
import type { IFilesystemProvider, IGitProvider } from './types'

/** An id that names no execution host. Never degrade to local — that is the whole defect class. */
export class UnresolvableExecutionHostError extends Error {
  constructor(readonly hostId: string | null | undefined) {
    super(
      `Cannot route work: ${JSON.stringify(hostId ?? null)} names no execution host. ` +
        'Refusing to fall back to this machine.'
    )
    this.name = 'UnresolvableExecutionHostError'
  }
}

/** Asking this process for a host it does not execute is a routing mistake, not a fallback. */
export class ExecutionHostNotDispatchableError extends Error {
  constructor(readonly hostId: ExecutionHostId) {
    super(`Execution host ${hostId} is not dispatched by this process.`)
    this.name = 'ExecutionHostNotDispatchableError'
  }
}

type LocalRoute = { kind: 'local'; hostId: typeof LOCAL_EXECUTION_HOST_ID }
/** Local git needs per-worktree options (WSL distro, shared links), so the route carries a factory. */
type LocalGitRoute = LocalRoute & { createProvider: typeof createLocalGitProvider }
/** Local file work authorizes against the caller's store, so the route carries a factory too. */
type LocalFilesystemRoute = LocalRoute & { createProvider: typeof createLocalFilesystemProvider }
type RuntimeRoute = { kind: 'runtime'; hostId: `runtime:${string}`; environmentId: string }
type SshRoute<TProvider> = {
  kind: 'ssh'
  hostId: `ssh:${string}`
  connectionId: string
  /** `null` is "remote, currently unreachable" — never "local". */
  provider: TProvider | null
}

// The SSH table stores `SshGitProvider`; narrowing the route to `IGitProvider` would drop the
// remote-only methods (commit-message plans, push-target materialization) that callers need.
export type ExecutionHostGitRoute = LocalGitRoute | RuntimeRoute | SshRoute<SshGitProvider>
export type ExecutionHostFilesystemRoute =
  | LocalFilesystemRoute
  | RuntimeRoute
  | SshRoute<IFilesystemProvider>

// Takes an unvalidated string rather than `ExecutionHostId`: validating is the point, and host
// ids also arrive from persistence and IPC where the compiler cannot vouch for them.
function parseRoutableHost(hostId: string | null | undefined): ParsedExecutionHost {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    throw new UnresolvableExecutionHostError(hostId)
  }
  return parsed
}

export function resolveGitRouteForHost(hostId: string | null | undefined): ExecutionHostGitRoute {
  const parsed = parseRoutableHost(hostId)
  switch (parsed.kind) {
    case 'local':
      return { kind: 'local', hostId: parsed.id, createProvider: createLocalGitProvider }
    case 'ssh':
      return {
        kind: 'ssh',
        hostId: parsed.id,
        connectionId: parsed.targetId,
        provider: getSshGitProvider(parsed.targetId) ?? null
      }
    case 'runtime':
      return { kind: 'runtime', hostId: parsed.id, environmentId: parsed.environmentId }
  }
}

export function resolveFilesystemRouteForHost(
  hostId: string | null | undefined
): ExecutionHostFilesystemRoute {
  const parsed = parseRoutableHost(hostId)
  switch (parsed.kind) {
    case 'local':
      return { kind: 'local', hostId: parsed.id, createProvider: createLocalFilesystemProvider }
    case 'ssh':
      return {
        kind: 'ssh',
        hostId: parsed.id,
        connectionId: parsed.targetId,
        provider: getSshFilesystemProvider(parsed.targetId) ?? null
      }
    case 'runtime':
      return { kind: 'runtime', hostId: parsed.id, environmentId: parsed.environmentId }
  }
}

type ReachableSshRoute<TProvider> = SshRoute<TProvider> & { provider: TProvider }
export type ReachableGitRoute = LocalGitRoute | ReachableSshRoute<SshGitProvider>
export type ReachableFilesystemRoute = LocalFilesystemRoute | ReachableSshRoute<IFilesystemProvider>

/** For work this process runs itself: `runtime:` and an unreachable SSH host throw, never run here. */
export function requireReachableGitRoute(hostId: string | null | undefined): ReachableGitRoute {
  const route = resolveGitRouteForHost(hostId)
  switch (route.kind) {
    case 'local':
      return route
    case 'ssh': {
      const { provider } = route
      if (!provider) {
        throw sshGitProviderMissingError(route.connectionId)
      }
      return { ...route, provider }
    }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}

export function requireReachableFilesystemRoute(
  hostId: string | null | undefined
): ReachableFilesystemRoute {
  const route = resolveFilesystemRouteForHost(hostId)
  switch (route.kind) {
    case 'local':
      return route
    case 'ssh': {
      const { provider } = route
      if (!provider) {
        throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
      }
      return { ...route, provider }
    }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}

/** For call sites that are structurally remote-only: local and runtime are both routing errors. */
export function requireGitProviderForHost(hostId: string | null | undefined): IGitProvider {
  const route = requireReachableGitRoute(hostId)
  if (route.kind !== 'ssh') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route.provider
}

export function requireFilesystemProviderForHost(
  hostId: string | null | undefined
): IFilesystemProvider {
  const route = requireReachableFilesystemRoute(hostId)
  if (route.kind !== 'ssh') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  return route.provider
}
