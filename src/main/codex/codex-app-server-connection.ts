import { spawnProcess } from '../../shared/child-process/run-process'
import { RetryableProcessExitProof } from '../../shared/child-process/retryable-process-exit-proof'
import { createProviderSpawnSpec } from './codex-app-server-posix-supervisor'
import { buildCodexAppServerExitError } from './codex-app-server-exit-error'
import { initializeCodexAppServerConnection } from './codex-app-server-handshake'
import { CodexAppServerHandshakeExitUnprovenError } from './codex-app-server-handshake-exit-proof'
import { terminateCodexAppServerProcessTree } from './codex-app-server-process-teardown'
import { CODEX_SPAWN_TOKEN_ENV } from './codex-structured-owner-identity'
import { waitForProcessExitUntil } from './codex-process-exit-deadline'
import { NDJSON_MAX_LINE_BYTES } from '../../shared/main-process-ndjson-framer'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError
} from './codex-app-server-session'
import { createCodexAppServerRecordDispatcher } from './codex-app-server-record-dispatch'
import { createCodexAppServerRecordReader } from './codex-app-server-record-reader'
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
export { CodexAppServerFrameSizeError } from './codex-app-server-frame-size-error'

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
export const CODEX_APP_SERVER_MAX_RECORD_BYTES = NDJSON_MAX_LINE_BYTES

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

  let stderrTail = ''
  let nextRequestId = 1
  let exited = false
  let exitObserved = false
  let closing = false
  let exitReported = false
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

  child.on('exit', () => {
    observeExit()
    handleUnexpectedEnd()
  })

  function buildExitError(cause?: Error): Error {
    return buildCodexAppServerExitError(stderrTail, cause)
  }

  const dispatcher = createCodexAppServerRecordDispatcher({
    handlers,
    writeResponse,
    onProtocolFailure: (error) => {
      handleUnexpectedEnd(error)
      void terminateProcessTree()
    }
  })

  /** A death nobody asked for kills every in-flight call AND tells the owner,
   *  which is the only signal the session has that its lease is now worthless.
   *  Once only: an oversized line kills the child and its `close` arrives after,
   *  and a spawn failure arrives as both `error` and `close`. */
  function handleUnexpectedEnd(cause?: Error): void {
    if (!terminalError) {
      terminalError = buildExitError(cause)
      dispatcher.failPending(terminalError)
    }
    // Transport/protocol failures make the connection unusable immediately so
    // callers do not hang, but recovery must not treat that as a child exit
    // until the execution host has observed `exit`/`close`.
    if (exitObserved && !closing && !exitReported) {
      exitReported = true
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
      dispatcher.failPending(error)
      return
    }
    handleUnexpectedEnd(error)
    void terminateProcessTree()
  })

  const recordReader = createCodexAppServerRecordReader({
    stdout: child.stdout,
    maxRecordBytes: CODEX_APP_SERVER_MAX_RECORD_BYTES,
    onRecord: (parsed, line) => {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        handlers.onUnhandledFrame?.('frame:invalid-json', line)
        return
      }
      dispatcher.dispatch(parsed as Record<string, unknown>)
    },
    onRejected: (rejected) => {
      if (rejected.kind === 'invalid-json') {
        handlers.onUnhandledFrame?.('frame:invalid-json', rejected.line)
      } else {
        dispatcher.rejectOversized(rejected)
      }
    },
    onFatal: (error) => {
      handleUnexpectedEnd(error)
      void terminateProcessTree()
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
        dispatcher.deletePending(id)
        reject(new CodexAppServerTimeoutError(`codex app-server ${method} exceeded ${timeoutMs}ms`))
      }, timeoutMs)
      dispatcher.addPending(id, { method, resolve, reject, timer })
      try {
        sendLine(params === undefined ? { method, id } : { method, id, params })
      } catch (error) {
        dispatcher.deletePending(id)
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
            dispatcher.failPending(new Error('codex app-server process-tree exit was not proven'))
            return false
          }
          await waitForProcessExitUntil(exitPromise, FORCED_EXIT_MS)
        }
      }
      dispatcher.failPending(new Error('codex app-server connection closed'))
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
    pauseReading: recordReader.pause,
    resumeReading: recordReader.resume,
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
