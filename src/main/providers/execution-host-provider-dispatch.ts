/** Unknown/unserved hosts must fail closed; runtime SSH targets belong to their server, never this client. */

import {
  parseExecutionHostId,
  type ExecutionHostId,
  type LOCAL_EXECUTION_HOST_ID,
  type ParsedExecutionHost
} from '../../shared/execution-host'
import { createLocalFilesystemProvider } from './local-filesystem-provider'
import { createLocalGitProvider } from './local-git-provider'
import { SshHostNotServedError } from './ssh-host-not-served-error'

export class UnresolvableExecutionHostError extends Error {
  constructor(readonly hostId: string | null | undefined) {
    super(
      `Cannot route work: ${JSON.stringify(hostId ?? null)} names no execution host. ` +
        'Refusing to fall back to this machine.'
    )
    this.name = 'UnresolvableExecutionHostError'
  }
}

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

// Persistence/IPC supply unvalidated strings; the branded type cannot establish routing authority.
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
