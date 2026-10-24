import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import { createClaudeChildTreeReaper } from '../claude/claude-agent-sdk-exit-proof'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { buildCodexAppServerExitError } from './codex-app-server-exit-error'
import { withMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { initializeCodexAppServerConnection } from './codex-app-server-handshake'
import { CodexAppServerHandshakeExitUnprovenError } from './codex-app-server-handshake-exit-proof'
import {
  CodexAppServerTimeoutError,
  CodexAppServerUnsupportedError
} from './codex-app-server-session'
import { createCodexAppServerRecordDispatcher } from './codex-app-server-record-dispatch'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'
import { withProviderRequestTimeout } from '../provider-process/provider-request-timeout'
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

// Structured chat needs a persistent transport for approvals and streamed turns.
export type CodexAppServerLaunch = ProviderProcessLaunch

export const DEFAULT_CODEX_REQUEST_TIMEOUT_MS = 30_000

/** Builds the transport so an owner can record its process before initialization. */
async function connectCodexAppServer(
  launch: CodexAppServerLaunch,
  handlers: CodexAppServerConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner,
  initialize: boolean
): Promise<CodexAppServerConnection> {
  const managed = spawnManagedProviderProcess(launch, {
    spawnImpl,
    site: 'codex-app-server-teardown'
  })
  const { child } = managed
  const tree = createClaudeChildTreeReaper(child, {
    exited: () => managed.rootVerdict === 'exited'
  })

  let nextRequestId = 1
  let closing = false
  let closesInFlight = 0
  let exitReported = false
  // Several listeners can report one failure; preserve its first, specific cause.
  let terminalError: Error | null = null

  function buildExitError(cause?: Error): Error {
    const error = buildCodexAppServerExitError(managed.stderrTail(), cause)
    return managed.executableMissing ? withMissingProviderExecutable(error) : error
  }

  const dispatcher = createCodexAppServerRecordDispatcher({
    handlers,
    writeResponse,
    onProtocolFailure: (error) => {
      handleUnexpectedEnd(error)
      void managed.close()
    }
  })

  // Fail pending calls immediately, but notify the owner only once root exit is proven.
  function handleUnexpectedEnd(cause?: Error): void {
    if (!terminalError) {
      terminalError = buildExitError(cause)
      dispatcher.failPending(terminalError)
    }
    if (managed.rootVerdict === 'exited' && closesInFlight === 0 && !exitReported) {
      exitReported = true
      handlers.onExit?.(terminalError, { expected: closing })
    }
  }

  child.on('error', (error) => {
    handleUnexpectedEnd(error)
  })
  managed.onExit(() => handleUnexpectedEnd())
  child.stdin.on('error', (error) => {
    // Broken pipes invalidate the transport; during close, fail calls without claiming root exit.
    if (closing) {
      dispatcher.failPending(error)
      return
    }
    handleUnexpectedEnd(error)
    void managed.close()
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
      void managed.close()
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
    options: { timeoutMs?: number | null; onReply?: () => void } = {}
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
    const timeoutMs =
      options.timeoutMs === undefined ? DEFAULT_CODEX_REQUEST_TIMEOUT_MS : options.timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      // Null requests are bounded by their caller; timed requests belong to this call.
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              dispatcher.timeOutPending(id)
              reject(
                withProviderRequestTimeout(
                  new CodexAppServerTimeoutError(
                    `codex app-server ${method} exceeded ${timeoutMs}ms`
                  ),
                  { method, timeoutMs }
                )
              )
            }, timeoutMs)
      dispatcher.addPending(id, { method, resolve, reject, timer, onReply: options.onReply })
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
    closesInFlight += 1
    return managed
      .close(tree)
      .then((result) => {
        if (result.root === 'exited' && !exitReported) {
          exitReported = true
          handlers.onExit?.(terminalError ?? buildExitError(), { expected: closing })
        }
        dispatcher.failPending(new Error('codex app-server connection closed'))
        return result.root === 'exited'
      })
      .finally(() => {
        closesInFlight -= 1
        if (managed.rootVerdict === 'exited') {
          handleUnexpectedEnd()
        }
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
      const result = connection.closeResult
      return result?.root === 'exited' && result.tree !== 'exited'
    },
    get closeResult() {
      const result = managed.lastCloseResult
      return result && managed.rootVerdict === 'exited'
        ? { ...result, root: 'exited' as const }
        : result
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
    if (initialize) {
      handshaking = true
      // Direct opens cannot expose the connection for cancellation until initialization finishes.
      await initializeCodexAppServerConnection(connection, 15_000)
    }
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

/** Publishes the transport after its process identity is recorded, before initialization. */
export function spawnCodexAppServerConnection(
  launch: CodexAppServerLaunch,
  handlers: CodexAppServerConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner = spawnProcess
): Promise<CodexAppServerConnection> {
  return connectCodexAppServer(launch, handlers, spawnImpl, false)
}

export function openCodexAppServerConnection(
  launch: CodexAppServerLaunch,
  handlers: CodexAppServerConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner = spawnProcess
): Promise<CodexAppServerConnection> {
  return connectCodexAppServer(launch, handlers, spawnImpl, true)
}
