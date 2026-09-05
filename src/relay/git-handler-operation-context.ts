import type { RequestContext } from './dispatcher'
import type { InFlightPromiseDedupe } from '../shared/in-flight-promise-dedupe'
import type { GitCapabilityCache } from '../shared/git-capability-cache'
import type { SubmodulePathsCache } from './git-handler-submodule-ops'
import type { RelayFilesystemWatchRegistry } from './relay-filesystem-watch-registry'

export const GIT_BULK_CHUNK_SIZE = 100

export type GitHandlerCommandOptions = {
  maxBuffer?: number
  disableOptionalLocks?: boolean
  signal?: AbortSignal
  nonInteractive?: boolean
  stdin?: string
  timeout?: number
  terminationBarrier?: boolean
}

export type GitHandlerCommandResult = { stdout: string; stderr: string }
export type GitHandlerWatcherRegistry = Pick<RelayFilesystemWatchRegistry, 'runWithRemovalFence'>

export type GitHandlerOperationHost = {
  readonly gitDiffReadDedupe: InFlightPromiseDedupe<unknown>
  readonly gitCapabilities: GitCapabilityCache
  readonly submodulePathsCache: SubmodulePathsCache
  readonly watcherRegistry: GitHandlerWatcherRegistry | undefined
  git(
    args: string[],
    cwd: string,
    opts?: GitHandlerCommandOptions
  ): Promise<GitHandlerCommandResult>
  gitBuffer(args: string[], cwd: string): Promise<Buffer>
  spawnClone(
    args: string[],
    cwd: string,
    progressId: string,
    context?: RequestContext
  ): Promise<GitHandlerCommandResult>
  clearGitMutationReadCaches(): void
  runWithGitReadCacheClear<T>(run: () => Promise<T>): Promise<T>
  maybeStreamResponse(
    result: unknown,
    params: Record<string, unknown>,
    context: RequestContext | undefined
  ): unknown
}

export abstract class GitHandlerOperationContext {
  constructor(private readonly host: GitHandlerOperationHost) {}

  protected get gitDiffReadDedupe(): InFlightPromiseDedupe<unknown> {
    return this.host.gitDiffReadDedupe
  }

  protected get gitCapabilities(): GitCapabilityCache {
    return this.host.gitCapabilities
  }

  protected get submodulePathsCache(): SubmodulePathsCache {
    return this.host.submodulePathsCache
  }

  protected get watcherRegistry(): GitHandlerWatcherRegistry | undefined {
    return this.host.watcherRegistry
  }

  protected git(
    args: string[],
    cwd: string,
    opts?: GitHandlerCommandOptions
  ): Promise<GitHandlerCommandResult> {
    return this.host.git(args, cwd, opts)
  }

  protected gitBuffer(args: string[], cwd: string): Promise<Buffer> {
    return this.host.gitBuffer(args, cwd)
  }

  protected spawnClone(
    args: string[],
    cwd: string,
    progressId: string,
    context?: RequestContext
  ): Promise<GitHandlerCommandResult> {
    return this.host.spawnClone(args, cwd, progressId, context)
  }

  protected clearGitMutationReadCaches(): void {
    this.host.clearGitMutationReadCaches()
  }

  protected runWithGitReadCacheClear<T>(run: () => Promise<T>): Promise<T> {
    return this.host.runWithGitReadCacheClear(run)
  }

  protected maybeStreamResponse(
    result: unknown,
    params: Record<string, unknown>,
    context: RequestContext | undefined
  ): unknown {
    return this.host.maybeStreamResponse(result, params, context)
  }

  protected literalPathspec(filePath: string): string {
    // Why: source-control selections are concrete paths, not user-authored Git globs.
    return `:(literal)${filePath}`
  }
}
