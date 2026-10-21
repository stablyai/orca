import { joinWorktreeRelativePath, normalizeRuntimeRelativePath } from '../runtime-relative-paths'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { GitWorktreeInfo, Worktree } from '../../../shared/worktree/types'
import {
  ExecutionHostNotDispatchableError,
  resolveFilesystemRouteForHost
} from '../../providers/execution-host-provider-dispatch'
import { resolveRuntimeAuthorizedPath } from './chat-scratch-file-root'
import type {
  createLocalFilesystemProvider,
  LocalFilesystemProvider,
  LocalFilesystemProviderOptions
} from '../../providers/local-filesystem-provider'
import { SshHostNotServedError } from '../../providers/ssh-host-not-served-error'

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
  | { kind: 'local'; createProvider: typeof createLocalFilesystemProvider }
  /** An SSH target this process does not serve; it fails or reports empty, never reads here. */
  | { kind: 'ssh'; connectionId: string }

export function runtimeFileRouteForTarget(target: {
  executionHostId: ExecutionHostId
}): RuntimeFileRoute {
  const route = resolveFilesystemRouteForHost(target.executionHostId)
  switch (route.kind) {
    case 'local':
      return { kind: 'local', createProvider: route.createProvider }
    case 'ssh':
      return { kind: 'ssh', connectionId: route.connectionId }
    case 'runtime':
      throw new ExecutionHostNotDispatchableError(route.hostId)
  }
}

/** What a runtime command supplies for local work; path authorization is always the runtime's. */
export type RuntimeLocalFileHost = Omit<LocalFilesystemProviderOptions, 'resolveAuthorizedPath'>

/** The local route for work this process runs itself; `ssh:` and `runtime:` hosts throw. */
export function requireLocalRuntimeFileRoute(target: {
  executionHostId: ExecutionHostId
}): Extract<RuntimeFileRoute, { kind: 'local' }> {
  const route = runtimeFileRouteForTarget(target)
  if (route.kind === 'ssh') {
    throw new SshHostNotServedError(route.connectionId)
  }
  return route
}

/** A provider for the target's own host, authorized against `host`'s store. */
export function requireRuntimeFileProvider(
  target: { executionHostId: ExecutionHostId },
  host: RuntimeLocalFileHost
): LocalFilesystemProvider {
  return requireLocalRuntimeFileRoute(target).createProvider({
    requireStore: () => host.requireStore(),
    resolveAuthorizedPath: resolveRuntimeAuthorizedPath
  })
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

export async function resolveFileExplorerPath(
  host: { resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget> },
  worktreeSelector: string,
  relativePath: string
): Promise<RuntimeFileExplorerPath> {
  const [target] = await resolveFileExplorerPaths(host, worktreeSelector, [relativePath])
  return target
}

export async function resolveFileExplorerPaths(
  host: { resolveRuntimeFileTarget(selector: string): Promise<ResolvedRuntimeFileTarget> },
  worktreeSelector: string,
  relativePaths: readonly string[]
): Promise<RuntimeFileExplorerPath[]> {
  const target = await host.resolveRuntimeFileTarget(worktreeSelector)
  return relativePaths.map((relativePath) => ({
    worktree: target.worktree,
    path: joinWorktreeRelativePath(
      target.worktree.path,
      normalizeRuntimeRelativePath(relativePath, target.worktree.path)
    ),
    executionHostId: target.executionHostId
  }))
}
