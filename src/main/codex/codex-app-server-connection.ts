import { spawnProcess } from '../../shared/child-process/run-process'
import { RetryableProcessExitProof } from '../../shared/child-process/retryable-process-exit-proof'
import { createProviderSpawnSpec } from './codex-app-server-posix-supervisor'
import { buildCodexAppServerExitError } from './codex-app-server-exit-error'
import { initializeCodexAppServerConnection } from './codex-app-server-handshake'
import { CodexAppServerHandshakeExitUnprovenError } from './codex-app-server-handshake-exit-proof'
import { isAppServerRecord, parseCodexAppServerJsonLine } from './codex-app-server-jsonl'
import { terminateCodexAppServerProcessTree } from './codex-app-server-process-teardown'
import { CodexAppServerRequestError } from './codex-app-server-request-error'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { waitForProcessExitUntil } from './codex-process-exit-deadline'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError,
  isCodexMethodNotFoundError
} from './codex-app-server-session'
import type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers
} from './codex-app-server-connection-types'

export type {
  CodexAppServerConnection,
  CodexAppServerConnectionHandlers,
  CodexAppServerServerRequest
} from './codex-app-server-connection-types'
export {
  CodexAppServerRequestError,
  isCodexAppServerRequestError
} from './codex-app-server-request-error'

// Structured chat needs a persistent bidirectional child and per-request deadlines;
// the request-scoped app-server runner cannot carry approvals or streamed turns.

export type CodexAppServerLaunch = {
  command: string
  args: string[]
  /** Workspace directory used by the provider process itself. */
  cwd?: string
  /** Overlay on the inherited environment — the pinned CODEX_HOME lives here. */
  env?: Record<string, string>
  /** Keys stripped after the overlay, matching `CodexAppServerInvocation`. */
  envToDelete?: readonly string[]
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const GRACEFUL_EXIT_MS = 1_500
const FORCED_EXIT_MS = 1_000
const STDERR_TAIL_MAX_BYTES = 8192
const STDOUT_LINE_MAX_BYTES = 1024 * 1024

type PendingRequest = {
  method: string
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Spawns `codex app-server`, completes the initialize handshake, and returns a
 * connection that stays open until `close()`. Rejects — after reaping the child
 * — when the handshake cannot complete.
 */
export async function openCodexAppServerConnection(
  launch: CodexAppServerLaunch,
  handlers: CodexAppServerConnectionHandlers = {},
  spawnImpl: typeof spawnProcess = spawnProcess
): Promise<CodexAppServerConnection> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...launch.env }
  for (const key of launch.envToDelete ?? []) {
    delete childEnv[key]
  }
  const spawnSpec = createProviderSpawnSpec(launch, childEnv, process.platform)
  const child = spawnImpl(spawnSpec)
  const spawnToken = launch.env?.[CODEX_SPAWN_TOKEN_ENV]

  function terminateProcessTree(): Promise<boolean> {
    // The supervisor and provider own separate POSIX groups so the supervisor can prove the
    // provider group empty before relaying its exit. Forced wrapper teardown uses descendant proof.
    return terminateCodexAppServerProcessTree(child, spawnToken)
  }

  const pending = new Map<number, PendingRequest>()
  let stderrTail = ''
  let nextRequestId = 1
  let exited = false
  let exitObserved = false
  let closing = false
  const exitProof = new RetryableProcessExitProof()
  /** First terminal cause, or null while the transport is still usable. Set once:
   *  a child that dies reaches us through several listeners, and the specific
   *  first cause is the one worth reporting. */
  let terminalError: Error | null = null

  let resolveExit = (): void => undefined
  const exitPromise = new Promise<void>((resolve) => {
    resolveExit = resolve
  })

  function observeExit(): void {
    exited = true
    exitObserved = true
    resolveExit()
  }

  child.on('exit', observeExit)

  function buildExitError(cause?: Error): Error {
    return buildCodexAppServerExitError(stderrTail, cause)
  }

  function failPending(error: Error): void {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    pending.clear()
  }

  /** A death nobody asked for kills every in-flight call AND tells the owner,
   *  which is the only signal the session has that its lease is now worthless.
   *  Once only: an oversized line kills the child and its `close` arrives after,
   *  and a spawn failure arrives as both `error` and `close`. */
  function handleUnexpectedEnd(cause?: Error): void {
    if (terminalError) {
      return
    }
    terminalError = buildExitError(cause)
    failPending(terminalError)
    if (!closing) {
      handlers.onExit?.(terminalError)
    }
  }

  child.on('error', (error) => {
    handleUnexpectedEnd(error)
  })
  child.on('close', () => {
    observeExit()
    handleUnexpectedEnd()
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES)
  })
  child.stdin.on('error', (error) => {
    // A broken pipe is terminal, not one failed write: every later request can
    // only error or time out, so the session must learn its lease is worthless
    // instead of staying live in front of a child nobody can reach. During a
    // close the reap is already under way and `exited` must stay honest, or
    // `close` would skip the kill it still owes.
    if (closing) {
      failPending(error)
      return
    }
    void terminateProcessTree()
    handleUnexpectedEnd(error)
  })

  function dispatchMessage(message: Record<string, unknown>): void {
    const hasMethod = typeof message.method === 'string'
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (hasMethod && hasId) {
      handlers.onServerRequest?.({
        id: message.id as number | string,
        method: message.method as string,
        params: message.params
      })
      return
    }
    if (hasMethod) {
      handlers.onNotification?.(message.method as string, message.params)
      return
    }
    if (typeof message.id !== 'number') {
      handlers.onUnhandledFrame?.('frame:unclassified', message)
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) {
      handlers.onUnhandledFrame?.('response:unmatched', message)
      return
    }
    pending.delete(message.id)
    clearTimeout(waiter.timer)
    const error = message.error
    if (isAppServerRecord(error)) {
      const detail = typeof error.message === 'string' ? error.message : 'unknown error'
      waiter.reject(
        isCodexMethodNotFoundError(error)
          ? new CodexAppServerUnsupportedError(
              `codex app-server does not support ${waiter.method}: ${detail}`
            )
          : new CodexAppServerRequestError(
              waiter.method,
              typeof error.code === 'number' ? error.code : null,
              `codex app-server ${waiter.method} failed: ${detail}`
            )
      )
      return
    }
    waiter.resolve(message.result)
  }

  let stdoutBuffer = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdoutBuffer += chunk
    if (Buffer.byteLength(stdoutBuffer) > STDOUT_LINE_MAX_BYTES) {
      child.stdout.destroy()
      void terminateProcessTree()
      handleUnexpectedEnd(new Error('codex app-server emitted an oversized JSONL line'))
      return
    }
    let newlineIndex: number
    while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim()
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      if (!line) {
        continue
      }
      const parsed = parseCodexAppServerJsonLine(line)
      if (!parsed) {
        handlers.onUnhandledFrame?.('frame:invalid-json', line)
        continue
      }
      try {
        dispatchMessage(parsed)
      } catch (error) {
        child.stdout.destroy()
        void terminateProcessTree()
        handleUnexpectedEnd(error instanceof Error ? error : new Error(String(error)))
        return
      }
    }
  })

  function sendLine(payload: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  function notify(method: string, params?: Record<string, unknown>): void {
    if (exited || terminalError) {
      return
    }
    try {
      sendLine(params === undefined ? { method } : { method, params })
    } catch {
      // Fire-and-forget; the next request surfaces a dead child.
    }
  }

  function request(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    if (closing) {
      return Promise.reject(new Error(`codex app-server connection is closed (${method})`))
    }
    if (terminalError) {
      return Promise.reject(terminalError)
    }
    if (exited) {
      return Promise.reject(buildExitError())
    }
    const id = nextRequestId++
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<unknown>((resolve, reject) => {
      // Why: per request, not per session — a chat session outlives every call,
      // so only the individual call can carry a deadline.
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new CodexAppServerTimeoutError(`codex app-server ${method} exceeded ${timeoutMs}ms`))
      }, timeoutMs)
      pending.set(id, { method, resolve, reject, timer })
      try {
        sendLine(params === undefined ? { method, id } : { method, id, params })
      } catch (error) {
        pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  function writeResponse(payload: Record<string, unknown>): void {
    if (exited || terminalError || child.stdin.destroyed || !child.stdin.writable) {
      return
    }
    try {
      sendLine(payload)
    } catch {
      // The turn that asked is already gone with the child.
    }
  }

  function close(): Promise<boolean> {
    if (exitObserved) {
      return Promise.resolve(true)
    }
    closing = true
    return exitProof.run(async () => {
      try {
        child.stdin.end()
      } catch {
        // Already destroyed; the reap below still runs.
      }
      if (!exited) {
        await waitForProcessExitUntil(exitPromise, GRACEFUL_EXIT_MS)
        if (!exited) {
          const treeExited = await terminateProcessTree()
          if (!treeExited) {
            failPending(new Error('codex app-server process-tree exit was not proven'))
            return false
          }
          await waitForProcessExitUntil(exitPromise, FORCED_EXIT_MS)
        }
      }
      failPending(new Error('codex app-server connection closed'))
      return exitObserved
    })
  }

  const connection: CodexAppServerConnection = {
    get pid() {
      return child.pid
    },
    get closed() {
      return closing || exited || terminalError !== null
    },
    request,
    notify,
    respond: (id, result) => writeResponse({ id, result }),
    respondWithError: (id, code, message) => writeResponse({ id, error: { code, message } }),
    close
  }

  try {
    await initializeCodexAppServerConnection(connection)
  } catch (error) {
    if ((await close()) !== true) {
      throw new CodexAppServerHandshakeExitUnprovenError(connection, error)
    }
    throw error instanceof CodexAppServerUnsupportedError ||
      error instanceof CodexAppServerTimeoutError
      ? error
      : buildExitError(error instanceof Error ? error : new Error(String(error)))
  }
  return connection
}
