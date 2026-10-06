import { spawnProcess } from '../../shared/child-process/run-process'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { buildCodexAppServerExitError } from './codex-app-server-exit-error'
import { initializeCodexAppServerConnection } from './codex-app-server-handshake'
import { CodexAppServerHandshakeExitUnprovenError } from './codex-app-server-handshake-exit-proof'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError
} from './codex-app-server-session'
import { createCodexAppServerRecordDispatcher } from './codex-app-server-record-dispatch'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'
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
export { ROOT_ONLY_GRACEFUL_EXIT_MS as GRACEFUL_EXIT_MS } from '../provider-process/provider-process-close'

// Structured chat needs a persistent bidirectional child and per-request deadlines;
// the request-scoped app-server runner cannot carry approvals or streamed turns.

export type CodexAppServerLaunch = ProviderProcessLaunch

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

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
  const managed = spawnManagedProviderProcess(launch, {
    spawnImpl,
    site: 'codex-app-server-teardown'
  })
  const { child, terminateTree: terminateProcessTree } = managed

  let nextRequestId = 1
  let closing = false
  let exitReported = false
  /** First terminal cause, or null while the transport is still usable. Set once:
   *  a child that dies reaches us through several listeners, and the specific
   *  first cause is the one worth reporting. */
  let terminalError: Error | null = null

  function buildExitError(cause?: Error): Error {
    return buildCodexAppServerExitError(managed.stderrTail(), cause)
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
   *  Once only: a fatal handler failure kills the child before `close` arrives,
   *  and a spawn failure arrives as both `error` and `close`. */
  function handleUnexpectedEnd(cause?: Error): void {
    if (!terminalError) {
      terminalError = buildExitError(cause)
      dispatcher.failPending(terminalError)
    }
    // Transport/protocol failures make the connection unusable immediately so
    // callers do not hang, but recovery must not treat that as a child exit
    // until the execution host has observed `exit`/`close`.
    if (managed.rootVerdict === 'exited' && !exitReported) {
      exitReported = true
      handlers.onExit?.(terminalError, { expected: closing })
    }
  }

  child.on('error', (error) => {
    handleUnexpectedEnd(error)
  })
  managed.onExit(() => handleUnexpectedEnd())
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

  const recordReader = createProviderRecordReader({
    stdout: child.stdout,
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
    if (managed.rootVerdict === 'exited' || terminalError) {
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
    if (managed.rootVerdict === 'exited') {
      return Promise.reject(buildExitError())
    }
    const id = nextRequestId++
    const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    return new Promise<unknown>((resolve, reject) => {
      // Why: per request, not per session — a chat session outlives every call,
      // so only the individual call can carry a deadline.
      const timer = setTimeout(() => {
        dispatcher.timeOutPending(id)
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
    if (
      managed.rootVerdict === 'exited' ||
      terminalError ||
      child.stdin.destroyed ||
      !child.stdin.writable
    ) {
      return
    }
    try {
      sendLine(payload)
    } catch {
      // The turn that asked is already gone with the child.
    }
  }

  function close(): Promise<boolean> {
    closing ||= managed.rootVerdict !== 'exited'
    return managed.close().then((result) => {
      dispatcher.failPending(new Error('codex app-server connection closed'))
      return result.root === 'exited'
    })
  }

  const connection: CodexAppServerConnection = {
    get pid() {
      return child.pid
    },
    get closed() {
      return closing || managed.rootVerdict === 'exited' || terminalError !== null
    },
    get processTreeUnproven() {
      const tree = managed.lastCloseResult?.tree
      return (
        managed.lastCloseResult?.root === 'exited' && (tree === 'unverifiable' || tree === 'live')
      )
    },
    request,
    notify,
    respond: (id, result) => writeResponse({ id, result }),
    respondWithError: (id, code, message) => writeResponse({ id, error: { code, message } }),
    pauseReading: recordReader.pause,
    resumeReading: recordReader.resume,
    close
  }

  let handshaking = false
  try {
    // A spawn that failed has no pid; the handshake below reports why.
    if (child.pid !== undefined) {
      await handlers.onSpawned?.(child.pid)
    }
    handshaking = true
    await initializeCodexAppServerConnection(connection)
  } catch (error) {
    if ((await close()) !== true) {
      throw new CodexAppServerHandshakeExitUnprovenError(connection, error)
    }
    throw !handshaking ||
      error instanceof CodexAppServerUnsupportedError ||
      error instanceof CodexAppServerTimeoutError
      ? error
      : buildExitError(error instanceof Error ? error : new Error(String(error)))
  }
  return connection
}
