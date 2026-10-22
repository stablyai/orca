/**
 * Host-keyed provider dispatch: one route per execution host kind, `local` included.
 *
 * The input is an `ExecutionHostId`, never null, and an id that names no host throws instead of
 * degrading to `local`, so work whose host is unknown never runs on this client (#11163). The
 * resolution layer (`getRepoExecutionHostId`, `getWorktreeExecutionHostId`,
 * `resolveWorktreeExecutionHost`) reports `unresolved` as its own verdict.
 *
 * Each kind is its own variant so callers switch exhaustively:
 *   - `local` git and filesystem routes carry a per-call factory, because they need per-worktree
 *     options (WSL distro, shared links, admission tier) a shared provider would drop.
 *   - `runtime:<env>` is forwarded to that server. Its repo's `connectionId` names the server's SSH
 *     target, so it must never reach this client's SSH table.
 *   - `ssh` names an SSH target this process does not serve; work on it throws
 *     `SshHostNotServedError`, never runs locally.
 */

import {
  parseExecutionHostId,
  type ExecutionHostId,
  type LOCAL_EXECUTION_HOST_ID,
  type ParsedExecutionHost
} from '../../shared/execution-host'
import { createLocalFilesystemProvider } from './local-filesystem-provider'
import { createLocalGitProvider } from './local-git-provider'
import { SshHostNotServedError } from './ssh-host-not-served-error'

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
type SshRoute = { kind: 'ssh'; hostId: `ssh:${string}`; connectionId: string }

export type ExecutionHostGitRoute = LocalGitRoute | RuntimeRoute | SshRoute
export type ExecutionHostFilesystemRoute = LocalFilesystemRoute | RuntimeRoute | SshRoute

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
      return { kind: 'ssh', hostId: parsed.id, connectionId: parsed.targetId }
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
      return { kind: 'ssh', hostId: parsed.id, connectionId: parsed.targetId }
    case 'runtime':
      return { kind: 'runtime', hostId: parsed.id, environmentId: parsed.environmentId }
  }
}

/** For work this process runs itself: `ssh:` and `runtime:` hosts throw, never run here. */
export function requireReachableGitRoute(hostId: string | null | undefined): LocalGitRoute {
  return requireLocalRoute(resolveGitRouteForHost(hostId))
}

export function requireReachableFilesystemRoute(
  hostId: string | null | undefined
): LocalFilesystemRoute {
  return requireLocalRoute(resolveFilesystemRouteForHost(hostId))
}

function requireLocalRoute<TLocal extends LocalRoute>(
  route: TLocal | RuntimeRoute | SshRoute
): TLocal {
  switch (route.kind) {
    case 'local':
      return route
    case 'ssh':
      throw new SshHostNotServedError(route.connectionId)
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}
