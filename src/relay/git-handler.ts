import type { RelayDispatcher, RequestContext } from '../wsl-guest/dispatcher'
import type { RelayContext } from './context'
import { expandTilde } from './context'
import { MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES } from '../shared/in-flight-promise-dedupe'
import { GitStatusReadLeaseOwner } from '../shared/git-status-read-lease-owner'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import {
  clearSubmodulePathsCache,
  createSubmodulePathsCache,
  type SubmodulePathsCache
} from './git-handler-submodule-ops'
import { GitResponseStreamRegistry, maybeStreamRpcResponse } from './git-response-stream'
import { clearGitStatusLineStatsCache } from '../shared/git-status-line-stats-cache'
import { invalidateGitBranchLineTotalInFlight } from '../shared/git-branch-line-total'
import { buildRelayGitEnv, buildRelayUnattendedGitEnv } from '../wsl-guest/relay-command-env'
import { getGitCloneFailureMessage } from '../shared/git-clone-failure-message'
import type {
  GitHandlerCommandOptions,
  GitHandlerCommandResult,
  GitHandlerWatcherRegistry
} from './git-handler-operation-context'
import { createGitHandlerOperationSet } from './git-handler-operation-set'
import { registerGitHandlers } from './git-handler-registration'
import { resolveGitFetchHeadCommand, runWithGitFetchHeadLock } from '../shared/git-fetch-head-lock'
import { MAX_GIT_BUFFER, runGitToTermination } from './git-handler-command-termination'
import { classifyGitCommand, findGitSubcommandIndex } from '../shared/git-command-classification'
import {
  GIT_SSH_CONFIG_ARGS,
  parseGitSshConfig,
  buildGitSshPolicyEnv
} from '../shared/git-ssh-policy-env'

export class GitHandler {
  private dispatcher: RelayDispatcher
  private readonly gitDiffReadDedupe = new GitStatusReadLeaseOwner<unknown>(
    MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES,
    30_000
  )
  private readonly gitCapabilities = new GitCapabilityCache()
  // Why: cache .gitmodules per instance to avoid SSH reads and test leakage.
  private submodulePathsCache: SubmodulePathsCache = createSubmodulePathsCache()

  // Why: RelayContext accepted for protocol back-compat (docs/relay-fs-allowlist-removal.md) but no longer consulted on git ops.
  constructor(
    dispatcher: RelayDispatcher,
    _context: RelayContext,
    private readonly watcherRegistry?: GitHandlerWatcherRegistry,
    // Why: use the bulk lane so large responses do not block interactive PTY echo. This handler
    // registers the `git.responseAck` route below, so in production it takes the relay's single
    // registry and FsHandler is handed the same one — see the header of git-response-stream.ts for
    // why a second registry both collides on stream ids and stalls on credit.
    private readonly responseStreams: GitResponseStreamRegistry = new GitResponseStreamRegistry()
  ) {
    this.dispatcher = dispatcher
    const handlers = createGitHandlerOperationSet({
      gitDiffReadDedupe: this.gitDiffReadDedupe,
      gitCapabilities: this.gitCapabilities,
      submodulePathsCache: this.submodulePathsCache,
      watcherRegistry: this.watcherRegistry,
      git: (args, cwd, opts) =>
        opts === undefined ? this.git(args, cwd) : this.git(args, cwd, opts),
      gitBuffer: (args, cwd, opts) => this.gitBuffer(args, cwd, opts),
      spawnClone: (args, cwd, progressId, context) =>
        this.spawnClone(args, cwd, progressId, context),
      clearGitMutationReadCaches: () => this.clearGitMutationReadCaches(),
      runWithGitReadCacheClear: (run) => this.runWithGitReadCacheClear(run),
      maybeStreamResponse: (result, params, context) =>
        this.maybeStreamResponse(result, params, context)
    })
    registerGitHandlers(
      this.dispatcher,
      handlers,
      (params, context) => this.responseAck(params, context),
      (params, context) => this.cancelResponseStream(params, context)
    )
    // Why: a detached client's git.responseAck frames never arrive; wake any pump parked on the ack window so it re-checks staleness and exits.
    this.dispatcher.onClientDetached?.(() => this.responseStreams.wakeAll())
  }

  dispose(): void {
    this.responseStreams.disposeAll()
    this.clearGitMutationReadCaches()
  }

  private responseAck(params: Record<string, unknown>, context: RequestContext): void {
    const streamId = params.streamId
    const seq = params.seq
    if (typeof streamId === 'number' && typeof seq === 'number') {
      this.responseStreams.recordAck(streamId, seq, context.clientId)
    }
  }

  private cancelResponseStream(params: Record<string, unknown>, context: RequestContext): void {
    const streamId = params.streamId
    if (typeof streamId === 'number') {
      this.responseStreams.abort(streamId, context.clientId)
    }
  }

  // Why: opt-in streaming — old clients/relays omit the flag and fall back to the plain result.
  private maybeStreamResponse(
    result: unknown,
    params: Record<string, unknown>,
    context: RequestContext | undefined
  ): unknown {
    return maybeStreamRpcResponse(result, params, context, this.responseStreams, this.dispatcher)
  }

  private clearGitMutationReadCaches(): void {
    this.gitDiffReadDedupe.invalidate()
    invalidateGitBranchLineTotalInFlight()
    clearGitStatusLineStatsCache()
    clearSubmodulePathsCache(this.submodulePathsCache)
  }

  private async runWithGitReadCacheClear<T>(run: () => Promise<T>): Promise<T> {
    // Why: git mutations can stale in-flight diff/.gitmodules reads; clear before and after so later reads cannot join them.
    this.clearGitMutationReadCaches()
    try {
      return await run()
    } finally {
      this.clearGitMutationReadCaches()
    }
  }

  private async git(
    args: string[],
    cwd: string,
    opts?: GitHandlerCommandOptions
  ): Promise<GitHandlerCommandResult> {
    const expandedCwd = expandTilde(cwd)
    const run = async (): Promise<{ stdout: string; stderr: string }> => {
      const env =
        classifyGitCommand(args) === 'network'
          ? await this.networkSshEnv(args, expandedCwd, opts?.signal)
          : opts?.nonInteractive
            ? buildRelayUnattendedGitEnv()
            : buildRelayGitEnv()
      if (opts?.disableOptionalLocks) {
        env.GIT_OPTIONAL_LOCKS = '0'
      }
      return runGitToTermination(
        args,
        {
          cwd: expandedCwd,
          env,
          maxBuffer: opts?.maxBuffer ?? MAX_GIT_BUFFER,
          timeout: opts?.timeout,
          signal: opts?.signal
        },
        opts?.stdin
      )
    }
    const command = resolveGitFetchHeadCommand(args, expandedCwd)
    return command.needsLock
      ? runWithGitFetchHeadLock(command.cwd, opts?.signal, run, command.gitDir)
      : run()
  }

  private async networkSshEnv(
    args: readonly string[],
    cwd: string,
    signal?: AbortSignal
  ): Promise<NodeJS.ProcessEnv> {
    const env = buildRelayUnattendedGitEnv()
    if (env.GIT_SSH_COMMAND || env.GIT_SSH) {
      return env
    }
    const subcommandIndex = findGitSubcommandIndex(args)
    let config = parseGitSshConfig('')
    try {
      const { stdout } = await this.git(
        [...args.slice(0, Math.max(0, subcommandIndex)), ...GIT_SSH_CONFIG_ARGS],
        cwd,
        { signal, timeout: 2500, nonInteractive: true }
      )
      config = parseGitSshConfig(stdout)
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 1) {
        throw error
      }
    }
    return buildGitSshPolicyEnv(env, config.command, config.variant).env
  }

  private async gitBuffer(
    args: string[],
    cwd: string,
    opts?: GitHandlerCommandOptions
  ): Promise<Buffer> {
    const result = await runGitToTermination(
      args,
      {
        cwd: expandTilde(cwd),
        env: buildRelayGitEnv(),
        captureStdoutAsBytes: true,
        signal: opts?.signal,
        timeout: opts?.timeout,
        maxBuffer: opts?.maxBuffer
      },
      undefined
    )
    if (!result.stdoutBytes) {
      throw new Error('Git byte capture returned no bytes.')
    }
    return result.stdoutBytes
  }

  private async spawnClone(
    args: string[],
    cwd: string,
    progressId: string,
    context?: RequestContext
  ): Promise<{ stdout: string; stderr: string }> {
    const env = await this.networkSshEnv(args, expandTilde(cwd), context?.signal)
    try {
      const result = await runGitToTermination(
        args,
        {
          cwd: expandTilde(cwd),
          env,
          signal: context?.signal,
          maxBuffer: 4096,
          outputCapture: 'tail',
          observeStderr: (chunk) => {
            for (const line of chunk.toString('utf8').split(/[\r\n]+/)) {
              const match = line.match(/^([\w\s]+):\s+(\d+)%/)
              if (match) {
                this.dispatcher.notify('git.cloneProgress', {
                  progressId,
                  phase: match[1].trim(),
                  percent: Number.parseInt(match[2], 10)
                })
              }
            }
          }
        },
        undefined
      )
      return result
    } catch (error) {
      if (context?.signal?.aborted) {
        throw error
      }
      throw new Error(
        `Clone failed: ${getGitCloneFailureMessage(error instanceof Error ? error.message : String(error))}`
      )
    }
  }
}
