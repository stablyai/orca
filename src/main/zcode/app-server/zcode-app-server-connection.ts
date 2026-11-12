import type { PipedProcessSpawner } from '@orca/process-host/process-spec'
import { spawnProcess } from '@orca/process-host'
import { spawnManagedProviderProcess } from '../../provider-process/managed-provider-process'
import { createClaudeChildTreeReaper } from '../../claude/claude-agent-sdk-exit-proof'
import type { ProviderProcessLaunch } from '../../provider-process/provider-process-launch'
import { buildZcodeAppServerExitError, ZcodeAppServerTimeoutError } from './zcode-app-server-errors'
import { withProviderSpawnAbsence } from '../../provider-process/provider-executable-missing'
import { afterProviderOutputDrains } from '../../provider-process/provider-exit-output-drain'
import { createProviderRecordReader } from '../../provider-process/provider-record-reader'
import { withProviderRequestTimeout } from '../../provider-process/provider-request-timeout'
import { createZcodeAppServerRecordDispatcher } from './zcode-app-server-record-dispatch'
import type {
  ZcodeAppServerConnection,
  ZcodeAppServerConnectionHandlers
} from './zcode-app-server-connection-types'

// zcode's own app-server is the chat transport; this module is only the wire: spawn, framing,
// pending calls and exit proof. zcode has no initialize handshake — its server asks
// `session/requestRuntimePreferences` when it is ready, which the owner answers by frame.

export type ZcodeAppServerLaunch = ProviderProcessLaunch

export const DEFAULT_ZCODE_REQUEST_TIMEOUT_MS = 30_000

/** Builds the transport so an owner can record its process before its handshake completes. */
export function spawnZcodeAppServerConnection(
  launch: ZcodeAppServerLaunch,
  handlers: ZcodeAppServerConnectionHandlers = {},
  spawnImpl: PipedProcessSpawner = spawnProcess
): Promise<ZcodeAppServerConnection> {
  const managed = spawnManagedProviderProcess(launch, {
    spawnImpl,
    site: 'zcode-app-server-teardown'
  })
  const { child } = managed
  const tree = createClaudeChildTreeReaper(child, {
    site: 'zcode-app-server-child-close',
    exited: () => managed.rootVerdict === 'exited',
    supervised: managed.supervised
  })

  let nextRequestId = 1
  let closing = false
  let closesInFlight = 0
  let exitReported = false
  // Several listeners can report one failure; preserve its first, specific cause.
  let terminalError: Error | null = null

  function buildExitError(cause?: Error, protocolFailure = false): Error {
    const error = buildZcodeAppServerExitError(managed.stderrTail(), cause, protocolFailure)
    return withProviderSpawnAbsence(error, managed.spawnAbsence)
  }

  const dispatcher = createZcodeAppServerRecordDispatcher({
    handlers,
    writeResponse,
    onProtocolFailure: (error) => {
      handleUnexpectedEnd(error, true)
      void managed.close()
    }
  })

  // Pending calls fail once output drained, so an answer written just before exit still settles
  // its call; the owner is notified only once root exit is proven.
  function handleUnexpectedEnd(cause?: Error, protocolFailure = false): void {
    if (!terminalError) {
      const error = buildExitError(cause, protocolFailure)
      terminalError = error
      if (protocolFailure) {
        dispatcher.failPending(error)
      } else {
        afterProviderOutputDrains(child.stdout, () => dispatcher.failPending(error), child)
      }
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
      dispatcher.dispatch(parsed as Record<string, unknown>)
    },
    onRejected: (rejected) => {
      if (rejected.kind === 'invalid-json') {
        handlers.onUnhandledFrame?.('frame:invalid-json', rejected.line)
      } else {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: zcode app-server frames and provider responses own these payload shapes.
        dispatcher.rejectOversized(rejected as Parameters<typeof dispatcher.rejectOversized>[0])
      }
    },
    onFatal: (error) => {
      handleUnexpectedEnd(error, true)
      void managed.close()
    }
  })

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
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    } catch {
      // The turn that asked is already gone with the child.
    }
  }

  function request(
    method: string,
    params?: Record<string, unknown>,
    options: { timeoutMs?: number | null; onReply?: (result?: unknown) => void } = {}
  ): Promise<unknown> {
    if (closing) {
      return Promise.reject(new Error(`zcode app-server connection is closed (${method})`))
    }
    if (terminalError) {
      return Promise.reject(terminalError)
    }
    if (managed.rootVerdict === 'exited') {
      return Promise.reject(buildExitError())
    }
    const id = nextRequestId++
    const timeoutMs =
      options.timeoutMs === undefined ? DEFAULT_ZCODE_REQUEST_TIMEOUT_MS : options.timeoutMs
    return new Promise<unknown>((resolve, reject) => {
      // Null requests are bounded by their caller; timed requests belong to this call.
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              dispatcher.deletePending(id)
              reject(
                withProviderRequestTimeout(
                  new ZcodeAppServerTimeoutError(
                    `zcode app-server ${method} exceeded ${timeoutMs}ms`
                  ),
                  { method, timeoutMs }
                )
              )
            }, timeoutMs)
      dispatcher.addPending(id, { method, resolve, reject, timer, onReply: options.onReply })
      try {
        child.stdin.write(
          `${JSON.stringify(params === undefined ? { method, id } : { method, id, params })}\n`
        )
      } catch (error) {
        dispatcher.deletePending(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
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
        dispatcher.failPending(new Error('zcode app-server connection closed'))
        return result.root === 'exited' || result.killDelivered === true
      })
      .finally(() => {
        closesInFlight -= 1
        if (managed.rootVerdict === 'exited') {
          handleUnexpectedEnd()
        }
      })
  }

  const connection: ZcodeAppServerConnection = {
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
    notify: (method, params) => {
      if (managed.rootVerdict === 'exited' || terminalError) {
        return
      }
      try {
        child.stdin.write(
          `${JSON.stringify(params === undefined ? { method } : { method, params })}\n`
        )
      } catch {
        // Fire-and-forget; the next request surfaces a dead child.
      }
    },
    respond: (id, result) => writeResponse({ id, result }),
    respondWithError: (id, code, message) => writeResponse({ id, error: { code, message } }),
    pauseReading: recordReader.pause,
    resumeReading: recordReader.resume,
    close
  }

  // A spawn that failed has no pid; a failing owner recording reaps the child here.
  return (async () => {
    if (child.pid !== undefined) {
      try {
        await handlers.onSpawned?.(child.pid)
      } catch (error) {
        if ((await close()) !== true) {
          throw error
        }
        throw error instanceof Error ? error : new Error(String(error))
      }
    }
    return connection
  })()
}
