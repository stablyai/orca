import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import { resolveProviderChildEnv } from '../provider-process/provider-process-launch'
import { stderrIndicatesMissingAppServer } from './app-server/codex-app-server-capability-signal'
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import {
  providerStderrForDisplay,
  supervisedProviderSpawnFailure
} from '../provider-process/provider-spawn-failure-report'
import {
  killCodexAppServerProcessTree,
  spawnCodexAppServerProcess,
  type CodexAppServerSpawn
} from './codex-app-server-process-tree-kill'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'

export type CodexAppServerInvocation = {
  command: string
  args: string[]
  cwd?: string
  /** Pairs the CLI with its Node runtime to avoid NODE_MODULE_VERSION mismatches; null only for guest launchers. */
  cliPath: string | null
  /** Overlay applied on top of the inherited environment (e.g. CODEX_HOME). */
  env?: Record<string, string>
  /** Keys stripped after the overlay, e.g. CODEX_HOME when targeting the real ~/.codex. */
  envToDelete?: readonly string[]
  timeoutMs: number
  signal?: AbortSignal
  /** Kill unsupervised plugin trees before stdin EOF; root exit leaves children behind and blocks tree killing. */
  treeKillOnFinish?: boolean
}

/** Missing app-server subcommand or RPC method; only this class marks capability caches unsupported. */
export class CodexAppServerUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerUnsupportedError'
  }
}

export class CodexAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexAppServerTimeoutError'
  }
}

export function isCodexAppServerUnsupportedError(error: unknown): boolean {
  return error instanceof Error && error.name === 'CodexAppServerUnsupportedError'
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: { code?: number; message?: string }
}

export type CodexAppServerRpc = {
  signal?: AbortSignal
  /** Per-call deadline within the session deadline; absent/null uses only the session deadline. */
  request: (
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number | null }
  ) => Promise<unknown>
  notify: (method: string, params?: Record<string, unknown>) => void
}

const JSON_RPC_METHOD_NOT_FOUND = -32601
const STDERR_DETAIL_MAX_CHARS = 400
const CODEX_APP_SERVER_KILL_SITE = 'codex-app-server-session'

// Only method-not-found responses prove absence rather than a transient failure.
export function isCodexMethodNotFoundError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false
  }
  const { code, message } = error as { code?: unknown; message?: unknown }
  return (
    code === JSON_RPC_METHOD_NOT_FOUND ||
    /method not found/i.test(typeof message === 'string' ? message : '')
  )
}

/** Runs a bounded JSONL session; the POSIX supervisor also stops its group if Orca dies. */
export async function runCodexAppServerSession<T>(
  invocation: CodexAppServerInvocation,
  body: (rpc: CodexAppServerRpc) => Promise<T>,
  spawnImpl: CodexAppServerSpawn = spawnCodexAppServerProcess
): Promise<T> {
  invocation.signal?.throwIfAborted()
  // Strip CODEX_HOME after the overlay so default-home grants target the real ~/.codex.
  const childEnv = resolveProviderChildEnv(invocation, process.env)
  const pairedEnv = invocation.cliPath
    ? withCliRuntimeOnPath(invocation.cliPath, childEnv)
    : childEnv
  const managed = spawnManagedProviderProcess(
    { command: invocation.command, args: invocation.args, cwd: invocation.cwd },
    {
      site: CODEX_APP_SERVER_KILL_SITE,
      inheritedEnv: pairedEnv,
      spawnImpl: (spec) =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the managed spec's first three stdio slots are 'pipe', so stdin, stdout and stderr exist.
        spawnImpl(spec.program, [...(spec.args ?? [])], {
          env: spec.env,
          cwd: spec.cwd,
          // Preserve the supervisor's group-report channel.
          stdio: spec.stdio ?? ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          ...(spec.detached ? { detached: true } : {})
        }) as ChildProcessWithoutNullStreams
    }
  )
  const { child } = managed

  const lifetime = new AbortController()
  let exited = false
  let exitCode: number | null = null
  let nextRequestId = 1
  let timedOut = false
  const pending = new Map<
    number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >()

  managed.onExit((exit) => {
    exited = true
    exitCode = exit.code
  })
  // Spawn failures emit error without exit; reject requests that would otherwise hang.
  let spawnError: Error | null = null
  child.on('error', (error) => {
    spawnError = error
    exited = true
    failPending(error)
  })
  // close guarantees complete stderr for classifying missing-subcommand versus transient failure.
  child.on('close', () => {
    failPending(buildEarlyExitError())
  })
  // Exit can race stdin.write(); reject RPCs on EPIPE instead of leaving an unhandled stream error.
  child.stdin.on('error', (error) => {
    failPending(error)
  })

  createProviderRecordReader({
    stdout: child.stdout,
    onRecord: (parsed) => {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return
      }
      const message = parsed as JsonRpcResponse
      if (typeof message.id !== 'number') {
        return
      }
      const waiter = pending.get(message.id)
      if (waiter) {
        pending.delete(message.id)
        waiter.resolve(message)
      }
    },
    onRejected: () => undefined,
    onFatal: failPending
  })

  function failPending(error: Error): void {
    for (const waiter of pending.values()) {
      waiter.reject(error)
    }
    pending.clear()
  }

  let rejectDeadline: (error: Error) => void = () => {}
  const deadlinePromise = new Promise<never>((_resolve, reject) => {
    rejectDeadline = reject
  })
  function endSession(error: Error): void {
    lifetime.abort(error)
    timedOut = true
    // A supervised child is stopped by the finally below, which this rejection runs at once.
    if (!managed.supervised) {
      killCodexAppServerProcessTree(child)
    }
    failPending(error)
    rejectDeadline(error)
  }
  const deadline = setTimeout(
    () =>
      endSession(
        new CodexAppServerTimeoutError(
          `codex app-server session exceeded ${invocation.timeoutMs}ms (${invocation.command})`
        )
      ),
    invocation.timeoutMs
  )
  const onAbort = (): void => endSession(new Error('codex app-server session stopped'))
  if (invocation.signal?.aborted) {
    onAbort()
  } else {
    invocation.signal?.addEventListener('abort', onAbort, { once: true })
  }

  function sendLine(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    const payload: Record<string, unknown> = { method }
    if (params !== undefined) {
      payload.params = params
    }
    try {
      sendLine(payload)
    } catch {
      // Notifications are fire-and-forget; a dead child fails the next request.
    }
  }

  async function requestRpc(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number | null } = {}
  ): Promise<unknown> {
    if (spawnError) {
      throw spawnError
    }
    if (timedOut) {
      throw new CodexAppServerTimeoutError('codex app-server session already timed out')
    }
    if (exited) {
      throw buildEarlyExitError()
    }
    const id = nextRequestId++
    let requestTimer: ReturnType<typeof setTimeout> | undefined
    const response = await new Promise<JsonRpcResponse>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      const { timeoutMs } = options
      if (typeof timeoutMs === 'number') {
        requestTimer = setTimeout(() => {
          pending.delete(id)
          reject(
            new CodexAppServerTimeoutError(`codex app-server ${method} exceeded ${timeoutMs}ms`)
          )
        }, timeoutMs)
      }
      const payload: Record<string, unknown> = { method, id }
      if (params !== undefined) {
        payload.params = params
      }
      try {
        sendLine(payload)
      } catch (error) {
        pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    }).finally(() => clearTimeout(requestTimer))
    if (response.error) {
      if (isCodexMethodNotFoundError(response.error)) {
        throw new CodexAppServerUnsupportedError(
          `codex app-server does not support ${method}: ${response.error.message ?? 'method not found'}`
        )
      }
      throw new Error(
        `codex app-server ${method} failed: ${response.error.message ?? 'unknown error'}`
      )
    }
    return response.result
  }

  // The supervisor's spawn-failure report reads as Node's own spawn error line.
  function stderrDetail(): string {
    return providerStderrForDisplay(managed.stderrTail()).trim().slice(0, STDERR_DETAIL_MAX_CHARS)
  }

  function buildEarlyExitError(): Error {
    // A supervisor reports a provider it could not start as exit 127; callers classify that error.
    const spawnFailure = managed.supervised
      ? supervisedProviderSpawnFailure(exitCode, managed.stderrTail())
      : null
    if (spawnFailure) {
      return spawnFailure.error
    }
    if (stderrIndicatesMissingAppServer(managed.stderrTail())) {
      return new CodexAppServerUnsupportedError(
        `codex CLI does not support the app-server subcommand: ${stderrDetail()}`
      )
    }
    return new Error(
      `codex app-server exited before completing the session${managed.stderrTail() ? `: ${stderrDetail()}` : ''}`
    )
  }

  try {
    const session = async (): Promise<T> => {
      await requestRpc('initialize', {
        clientInfo: { name: 'orca_desktop', title: 'Orca', version: '0.0.0' }
      })
      notify('initialized')
      return body({ request: requestRpc, notify, signal: lifetime.signal })
    }
    // Killing the child cannot settle a callback awaiting unrelated work; race the whole callback.
    return await Promise.race([session(), deadlinePromise])
  } catch (error) {
    if (
      error instanceof Error &&
      !(error instanceof CodexAppServerUnsupportedError) &&
      !(error instanceof CodexAppServerTimeoutError) &&
      stderrIndicatesMissingAppServer(managed.stderrTail())
    ) {
      throw new CodexAppServerUnsupportedError(
        `codex CLI does not support the app-server subcommand: ${stderrDetail()}`
      )
    }
    throw error
  } finally {
    lifetime.abort()
    // A session past its deadline is wedged; its stdin end would only add a grace.
    if (timedOut && managed.supervised && !exited) {
      try {
        child.stdin.end()
      } catch {
        // A destroyed stdin still leaves the SIGTERM and the close below.
      }
      child.kill('SIGTERM')
    }
    if (invocation.treeKillOnFinish && !managed.supervised && !exited) {
      await managed.terminateTree()
    }
    // Ends stdin, gives a supervisor its full stop time (a direct child 1.5 s), then the tree.
    await managed.close()
    clearTimeout(deadline)
    invocation.signal?.removeEventListener('abort', onAbort)
  }
}
