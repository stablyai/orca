import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'

type FatalMainProcessErrorKind = 'main_uncaught_exception' | 'main_unhandled_rejection'

type FatalMainProcessErrorDetails = {
  errorName: string
  errorMessage: string
  errorStack: string
  errorCode: string
}

function readErrorProperty(error: unknown, property: string): unknown {
  try {
    return error !== null && (typeof error === 'object' || typeof error === 'function')
      ? (error as Record<string, unknown>)[property]
      : undefined
  } catch {
    return undefined
  }
}

function boundedString(value: unknown, maxLength: number, fallback = ''): string {
  try {
    return String(value).slice(0, maxLength)
  } catch {
    return fallback
  }
}

function fatalMainProcessErrorDetails(error: unknown): FatalMainProcessErrorDetails {
  let isError = false
  try {
    isError = error instanceof Error
  } catch {
    // Why: a proxy can throw from instanceof; fatal diagnostics still need a safe fallback.
  }

  return {
    errorName: isError
      ? boundedString(readErrorProperty(error, 'name') ?? 'Error', 100, 'Error')
      : typeof error,
    errorMessage: isError
      ? boundedString(readErrorProperty(error, 'message') ?? '', 500)
      : boundedString(error, 500, '[unprintable value]'),
    errorStack: isError
      ? boundedString(readErrorProperty(error, 'stack') ?? '', 4_000)
          .split('\n')
          .slice(0, 12)
          .join('\n')
      : '',
    errorCode: boundedString(readErrorProperty(error, 'code') ?? '', 100)
  }
}

// Why: one broken resource can reject hundreds of concurrent restore chains; each record does a
// synchronous trace flush, so an uncapped storm stalls main and churns the trace-file rotation.
const RECORD_WINDOW_MS = 60_000
const RECORD_WINDOW_MAX = 20
let recordWindowStartedAt = 0
let recordWindowCount = 0
let recordsSuppressed = 0

/** Durably record a main-process fatal/near-fatal error before default handling runs. Exported for tests. */
export function recordFatalMainProcessError(kind: FatalMainProcessErrorKind, error: unknown): void {
  // Why: only rejections can storm; the one uncaught-exception record before the fatal re-throw
  // must never be lost to a window a storm already exhausted.
  if (kind === 'main_unhandled_rejection') {
    const now = Date.now()
    // Why: a backward clock jump (sleep/resume, NTP) would otherwise trap an exhausted window and suppress every breadcrumb until wall time catches up.
    if (now < recordWindowStartedAt || now - recordWindowStartedAt >= RECORD_WINDOW_MS) {
      recordWindowStartedAt = now
      recordWindowCount = 0
    }
    if (recordWindowCount >= RECORD_WINDOW_MAX) {
      recordsSuppressed += 1
      return
    }
    recordWindowCount += 1
  }
  const suppressedSinceLast = recordsSuppressed
  recordsSuppressed = 0
  const details = fatalMainProcessErrorDetails(error)
  try {
    recordDurableCrashBreadcrumb(
      kind,
      suppressedSinceLast > 0 ? { ...details, suppressedSinceLast } : details,
      kind
    )
  } catch {
    // Why: diagnostics must never turn a fatal-error report into a second fault.
  }
  try {
    console.error(
      `[${kind}] ${details.errorStack || `${details.errorName}: ${details.errorMessage}`}`
    )
  } catch {
    // Why: custom console sinks must not defeat the process-level safety guard.
  }
}

export function installUncaughtPipeErrorGuard(): void {
  const onUncaughtException = (error: unknown): void => {
    const errorCode = readErrorProperty(error, 'code')
    if (errorCode === 'EIO' || errorCode === 'EPIPE') {
      return
    }

    // Why (issue #9441): the re-throw below exits with a clean code and no macOS crash report; record durably first or the death is undiagnosable in the field.
    recordFatalMainProcessError('main_uncaught_exception', error)
    process.off('uncaughtException', onUncaughtException)
    // Why: throwing inside an uncaughtException handler exits with status 7 and hides the fault; re-throw next tick for the real stack.
    setImmediate(() => {
      throw error
    })
  }

  process.on('uncaughtException', onUncaughtException)
}

/** Keep one failed background promise from silently killing the whole app.
 *
 * Node's default kills the process on an unhandled rejection. Large-profile startup restore runs
 * hundreds of concurrent async chains (worktree scans, terminal reconnects) in main; a single
 * rejection in any of them exited the app with no crash report (issue #9441). Log it durably and
 * stay alive — dying cannot be less disruptive than continuing with one failed background task.
 */
export function installUnhandledRejectionLogging(): void {
  process.on('unhandledRejection', (reason) => {
    recordFatalMainProcessError('main_unhandled_rejection', reason)
  })
}
