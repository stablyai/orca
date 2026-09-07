import type { ExecutionHostId } from '../../shared/execution-host'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import {
  ExecutionHostNotDispatchableError,
  resolveFilesystemRouteForHost
} from '../providers/execution-host-provider-dispatch'
import { SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE } from '../providers/ssh-filesystem-dispatch'
import type { IFilesystemProvider } from '../providers/types'

export type ResolvedRuntimeFileWorktree = Worktree & { git: GitWorktreeInfo }

export type ResolvedRuntimeFileTarget = {
  worktree: ResolvedRuntimeFileWorktree
  /**
   * The host whose filesystem holds this workspace. Never optional and never null: the field it
   * replaced (`connectionId?: string`) spelled "runtime host", "unresolved" and "genuinely local"
   * all as `undefined`, so every path that could not resolve answered "local" and read remote
   * paths on the client (#11163). Unresolved now fails at resolution time instead of arriving here
   * as a silently-local target. Mirrors `RuntimeGitTarget.executionHostId`.
   */
  executionHostId: ExecutionHostId
}

/** A workspace-relative path already joined onto its host's root; `executionHostId` routes it. */
export type RuntimeFileExplorerPath = {
  worktree: ResolvedRuntimeFileWorktree
  path: string
  executionHostId: ExecutionHostId
}

/**
 * The two hosts this process can itself run a runtime filesystem command on, narrowed from the
 * shared host-keyed route in `src/main/providers/execution-host-provider-dispatch.ts`.
 *
 * `runtime:<env>` is deliberately not a variant, for the same reason it is not one for Git: the
 * files live on that environment's own server, which normalizes the call to its own `local`, and
 * the SSH target on its repo row is that server's *nested* one — addressable only as the pair
 * (environmentId, targetId). Handing that id to this client's SSH table reads a same-named target
 * in the wrong namespace, so it throws rather than routing.
 */
export type RuntimeFileRoute =
  | { kind: 'local' }
  /** `provider: null` is "remote and currently unreachable" — never "read it here". */
  | { kind: 'ssh'; connectionId: string; provider: IFilesystemProvider | null }

/** The remote half of the route, for leaf helpers that only ever run against an SSH host. */
export type RuntimeFileSshRoute = Extract<RuntimeFileRoute, { kind: 'ssh' }>

export function runtimeFileRouteForTarget(target: {
  executionHostId: ExecutionHostId
}): RuntimeFileRoute {
  const route = resolveFilesystemRouteForHost(target.executionHostId)
  switch (route.kind) {
    case 'local':
      return { kind: 'local' }
    case 'ssh':
      return { kind: 'ssh', connectionId: route.connectionId, provider: route.provider }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}

/**
 * `null` means exactly one thing: the host is `local`, and this command reads and writes here. An
 * unreachable SSH host and a `runtime:` host both throw.
 */
export function requireRuntimeFileProvider(target: {
  executionHostId: ExecutionHostId
}): IFilesystemProvider | null {
  const route = runtimeFileRouteForTarget(target)
  if (route.kind === 'local') {
    return null
  }
  if (!route.provider) {
    throw new Error(SSH_FILESYSTEM_PROVIDER_UNAVAILABLE_MESSAGE)
  }
  return route.provider
}

/**
 * The SSH target id for the leaf helpers that still address a connection by name — watcher release
 * keys, re-arm registration, remote path stats. `undefined` is `local`; a `runtime:` host throws
 * rather than surrendering its nested target id to this client's namespace.
 */
export function runtimeFileSshTargetId(target: {
  executionHostId: ExecutionHostId
}): string | undefined {
  const route = runtimeFileRouteForTarget(target)
  return route.kind === 'ssh' ? route.connectionId : undefined
}
