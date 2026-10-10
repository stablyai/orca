// One live `zcode app-server --stdio` child: NDJSON in and out, per-request deadlines, and
// reverse requests (tool approvals) answered through `respond`. ZCode's app-server performs no
// handshake — the first request may go out as soon as the child exists — so `open` only awaits
// `onSpawned` before returning.

import { spawnProcess } from '../../shared/child-process/run-process'
import { spawnManagedProviderProcess } from '../provider-process/managed-provider-process'
import type { ProviderProcessLaunch } from '../provider-process/provider-process-launch'
import { withMissingProviderExecutable } from '../provider-process/provider-executable-missing'
import { createZcodeAppServerRecordDispatcher } from './zcode-app-server-record-dispatch'
import { createProviderRecordReader } from '../provider-process/provider-record-reader'
import { providerStderrForDisplay } from '../provider-process/provider-spawn-failure-report'
import type {
  ZcodeAppServerConnection,
  ZcodeAppServerConnectionHandlers
} from './zcode-app-server-connection-types'

export type ZcodeAppServerLaunch = ProviderProcessLaunch

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const EXIT_DETAIL_MAX_CHARS = 400

export class ZcodeAppServerTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZcodeAppServerTimeoutError'
  }
}

function buildZcodeAppServerExitError(stderrTail: string, cause?: Error): Error {
  const tail = providerStderrForDisplay(stderrTail).trim().slice(0, EXIT_DETAIL_MAX_CHARS)
  const detail = cause ? `: ${cause.message}` : tail ? `: ${tail}` : ''
  return new Error(`zcode app-server connection ended${detail}`)
}

/** A protocol frame is a JSON object; arrays are not messages. */
function isZcodeWireRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Spawns the ZCode app-server child and returns a connection that stays open
 * until `close()`. Rejects — after reaping the child — when the child could not
 * be started or died before it was handed over.
 */
export async function openZcodeAppServerConnection(
  launch: ZcodeAppServerLaunch,
  handlers: ZcodeAppServerConnectionHandlers = {},
  spawnImpl: typeof spawnProcess = spawnProcess
): Promise<ZcodeAppServerConnection> {
  const managed = spawnManagedProviderProcess(launch, {
    spawnImpl,
    site: 'zcode-app-server-teardown',
    ...(handlers.onOutput ? { onOutput: handlers.onOutput } : {})
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
    const error = buildZcodeAppServerExitError(managed.stderrTail(), cause)
    return managed.executableMissing ? withMissingProviderExecutable(error) : error
  }

  const dispatcher = createZcodeAppServerRecordDispatcher({
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
      if (!isZcodeWireRecord(parsed)) {
        handlers.onUnhandledFrame?.('frame:invalid-json', line)
        return
      }
      dispatcher.dispatch(parsed)
    },
    onRejected: (rejected) => {
      if (rejected.kind === 'invalid-json') {
        // ZCode's startup notifications ride the same stream; a non-JSON line is
        // stdout pollution and means the protocol can no longer be trusted.
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
      return Promise.reject(new Error(`zcode app-server connection is closed (${method})`))
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
      const timer = setTimeout(() => {
        dispatcher.timeOutPending(id)
        reject(new ZcodeAppServerTimeoutError(`zcode app-server ${method} exceeded ${timeoutMs}ms`))
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
      dispatcher.failPending(new Error('zcode app-server connection closed'))
      return result.root === 'exited'
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

  try {
    // A spawn that failed has no pid; the exit below reports why.
    if (child.pid !== undefined) {
      await handlers.onSpawned?.(child.pid)
    }
  } catch (error) {
    if ((await close()) !== true) {
      throw new Error('zcode app-server child exit unproven after a failed handover', {
        cause: error
      })
    }
    throw error
  }
  return connection
}
