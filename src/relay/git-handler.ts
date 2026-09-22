import { execFile, spawn, type ExecFileOptions } from 'node:child_process'
import { promisify } from 'node:util'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { RelayContext } from './context'
import { expandTilde } from './context'
import { InFlightPromiseDedupe } from '../shared/in-flight-promise-dedupe'
import { GitCapabilityCache } from '../shared/git-capability-cache'
import {
  clearSubmodulePathsCache,
  createSubmodulePathsCache,
  type SubmodulePathsCache
} from './git-handler-submodule-ops'
import { GitResponseStreamRegistry, maybeStreamRpcResponse } from './git-response-stream'
import { clearGitStatusLineStatsCache } from '../shared/git-status-line-stats-cache'
import { invalidateGitBranchLineTotalInFlight } from '../shared/git-branch-line-total'
import { buildRelayGitEnv, buildRelayUnattendedGitEnv } from './relay-command-env'
import { getGitCloneFailureMessage } from '../shared/git-clone-failure-message'
import type {
  GitHandlerCommandOptions,
  GitHandlerCommandResult,
  GitHandlerWatcherRegistry
} from './git-handler-operation-context'
import { createGitHandlerOperationSet } from './git-handler-operation-set'
import { registerGitHandlers } from './git-handler-registration'
import { resolveGitFetchHeadCommand, runWithGitFetchHeadLock } from '../shared/git-fetch-head-lock'
import { endSubprocessStdin } from '../shared/subprocess-stdin-write'
import { MAX_GIT_BUFFER, runGitToTermination } from './git-handler-command-termination'

const execFileAsync = promisify(execFile)

function execFileWithStdin(
  command: string,
  args: string[],
  options: ExecFileOptions,
  stdin: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (
      error: Error | null,
      stdout: string | Buffer = '',
      stderr: string | Buffer = ''
    ): void => {
      if (settled) {
        return
      }
      settled = true
      if (error) {
        reject(Object.assign(error, { stdout, stderr }))
        return
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) })
    }
    const child = execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        finish(error, stdout, stderr)
        return
      }
      finish(null, stdout, stderr)
    })
    child.once('error', (error) => finish(error))
    endSubprocessStdin(child.stdin, stdin)
  })
}

export class GitHandler {
  private dispatcher: RelayDispatcher
  private readonly gitDiffReadDedupe = new InFlightPromiseDedupe<unknown>()
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
      gitBuffer: (args, cwd) => this.gitBuffer(args, cwd),
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
    this.gitDiffReadDedupe.clear()
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
      const env = opts?.nonInteractive ? buildRelayUnattendedGitEnv() : buildRelayGitEnv()
      if (opts?.disableOptionalLocks) {
        env.GIT_OPTIONAL_LOCKS = '0'
      }
      const execOptions = {
        cwd: expandedCwd,
        env,
        encoding: 'utf-8',
        maxBuffer: opts?.maxBuffer ?? MAX_GIT_BUFFER,
        timeout: opts?.timeout,
        signal: opts?.signal
      } satisfies ExecFileOptions
      if (opts?.terminationBarrier) {
        return runGitToTermination(args, execOptions, opts.stdin)
      }
      if (opts?.stdin !== undefined) {
        return execFileWithStdin('git', args, execOptions, opts.stdin)
      }
      const { stdout, stderr } = await execFileAsync('git', args, execOptions)
      return { stdout: String(stdout), stderr: String(stderr) }
    }
    const command = resolveGitFetchHeadCommand(args, expandedCwd)
    return command.needsLock
      ? runWithGitFetchHeadLock(command.cwd, opts?.signal, run, command.gitDir)
      : run()
  }

  private async gitBuffer(args: string[], cwd: string): Promise<Buffer> {
    const { stdout } = (await execFileAsync('git', args, {
      cwd,
      env: buildRelayGitEnv(),
      encoding: 'buffer',
      maxBuffer: MAX_GIT_BUFFER
    })) as { stdout: Buffer }
    return stdout
  }

  private async spawnClone(
    args: string[],
    cwd: string,
    progressId: string,
    context?: RequestContext
  ): Promise<{ stdout: string; stderr: string }> {
    return await new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: expandTilde(cwd),
        env: buildRelayUnattendedGitEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      const cleanup = (): void => {
        context?.signal?.removeEventListener('abort', onAbort)
      }
      const onAbort = (): void => {
        child.kill()
      }
      context?.signal?.addEventListener('abort', onAbort, { once: true })
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = (stdout + chunk.toString('utf-8')).slice(-4096)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        stderr = (stderr + text).slice(-4096)
        for (const line of text.split(/[\r\n]+/)) {
          const match = line.match(/^([\w\s]+):\s+(\d+)%/)
          if (match) {
            this.dispatcher.notify('git.cloneProgress', {
              progressId,
              phase: match[1].trim(),
              percent: Number.parseInt(match[2], 10)
            })
          }
        }
      })
      child.on('error', (error) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      })
      child.on('close', (code, signal) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        if (context?.signal?.aborted) {
          reject(new Error('Clone aborted'))
          return
        }
        if (code === 0 && !signal) {
          resolve({ stdout, stderr })
          return
        }
        reject(new Error(`Clone failed: ${getGitCloneFailureMessage(stderr)}`))
      })
    })
  }
}
