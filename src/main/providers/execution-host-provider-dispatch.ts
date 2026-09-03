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
 * Why a route union rather than a uniform `getGitProviderForHost(): IGitProvider`, which is the
 * VS Code shape (`registerProvider(Schemas.file, …)` symmetric with `Schemas.vscodeRemote`, and
 * `ENOPRO` when nothing matches). Two properties of this process, not style preferences:
 *
 *   - `local` git and filesystem work is free functions taking per-worktree execution options
 *     (`wslDistro`, `sharedLinkPaths`, admission tier), not an `IGitProvider`. There is no local
 *     provider object to register, and a stateless one would silently drop WSL routing.
 *   - `runtime:<env>` is not executed in this process *at all*. It is forwarded over the
 *     environment's transport (`runtimeEnvironments:call`) and the receiving server normalizes it to
 *     its own `local`. A repo row on a runtime host carries the server's *nested* SSH target in
 *     `connectionId`; that id is addressable only as the pair (environmentId, targetId). Handing it
 *     to this client's SSH table would dial a same-named target in the wrong namespace — turning a
 *     silent-local bug into a silent-wrong-host bug. `host-repo-catalog-snapshot` and
 *     `host-qualified-worktree-listing` already reject runtime hosts for the same reason.
 *
 * So the answer is Zed's shape — an enum on the owner (`Local { fs }` vs `Remote { … }`) — and the
 * three kinds are symmetric variants of it. Callers switch exhaustively, so `runtime` can no longer
 * collapse into `local` by omission.
 *
 * Note the deliberate second distinction inside the `ssh` variant: `provider: null` means "this host
 * is remote and currently unreachable", which is not the same answer as "this host is local" and can
 * no longer be spelled the same way. That mirrors the `live` / `unverifiable` / `exited` rule in
 * docs/reference/ssh-execution-boundary.md — loss of contact is never evidence of locality.
 */

import {
  parseExecutionHostId,
  type ExecutionHostId,
  type LOCAL_EXECUTION_HOST_ID,
  type ParsedExecutionHost
} from '../../shared/execution-host'
import { getSshGitProvider, SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE } from './ssh-git-dispatch'
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
export type ExecutionHostGitRoute = LocalRoute | RuntimeRoute | SshRoute<SshGitProvider>
export type ExecutionHostFilesystemRoute = LocalRoute | RuntimeRoute | SshRoute<IFilesystemProvider>

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
      return { kind: 'local', hostId: parsed.id }
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
      return { kind: 'local', hostId: parsed.id }
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

/** For call sites that are structurally remote-only: local and runtime are both routing errors. */
export function requireGitProviderForHost(hostId: string | null | undefined): IGitProvider {
  const route = resolveGitRouteForHost(hostId)
  if (route.kind !== 'ssh') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  if (!route.provider) {
    throw new Error(SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return route.provider
}

export function requireFilesystemProviderForHost(
  hostId: string | null | undefined
): IFilesystemProvider {
  const route = resolveFilesystemRouteForHost(hostId)
  if (route.kind !== 'ssh') {
    throw new ExecutionHostNotDispatchableError(route.hostId)
  }
  if (!route.provider) {
    throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return route.provider
}
