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
  /** Required resolved host: optional connectionId once collapsed runtime/unresolved into local (#11163). */
  executionHostId: ExecutionHostId
}

export type RuntimeFileExplorerPath = {
  worktree: ResolvedRuntimeFileWorktree
  path: string
  executionHostId: ExecutionHostId
}

/** This process serves local/SSH routes only. runtime:<env> belongs to that environment's server;
 * its nested SSH id is scoped by environment and must never enter this client's SSH namespace. */
export type RuntimeFileRoute =
  | { kind: 'local'; createProvider: typeof createLocalFilesystemProvider }
  /** Unsupported SSH routes must fail/degrade to empty, never read locally. */
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

export type RuntimeLocalFileHost = Omit<LocalFilesystemProviderOptions, 'resolveAuthorizedPath'>

export function requireLocalRuntimeFileRoute(target: {
  executionHostId: ExecutionHostId
}): Extract<RuntimeFileRoute, { kind: 'local' }> {
  const route = runtimeFileRouteForTarget(target)
  if (route.kind === 'ssh') {
    throw new SshHostNotServedError(route.connectionId)
  }
  return route
}

export function requireRuntimeFileProvider(
  target: { executionHostId: ExecutionHostId },
  host: RuntimeLocalFileHost
): LocalFilesystemProvider {
  return requireLocalRuntimeFileRoute(target).createProvider({
    requireStore: () => host.requireStore(),
    resolveAuthorizedPath: resolveRuntimeAuthorizedPath
  })
}

/** Local yields undefined; runtime hosts throw rather than expose nested SSH ids in this client's namespace. */
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
