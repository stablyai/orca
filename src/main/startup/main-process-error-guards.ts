import { recordDurableCrashBreadcrumb } from '../crash-reporting/durable-crash-breadcrumb'
import { removeBootstrapFatalExitGuard } from './bootstrap-fatal-exit-guard'

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
    // Even instanceof may throw through a proxy; preserve a safe diagnostic fallback.
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

// A restore rejection storm otherwise flushes traces synchronously hundreds of times and stalls main.
const RECORD_WINDOW_MS = 60_000
const RECORD_WINDOW_MAX = 20
let recordWindowStartedAt = 0
let recordWindowCount = 0
let recordsSuppressed = 0

/** Persist fatal/near-fatal evidence before default handling. */
export function recordFatalMainProcessError(kind: FatalMainProcessErrorKind, error: unknown): void {
  // Cap rejection storms only; never lose the final uncaught-exception record to their exhausted window.
  if (kind === 'main_unhandled_rejection') {
    const now = Date.now()
    // Reset after backward clock jumps so exhausted windows cannot suppress breadcrumbs until time catches up.
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
    // Diagnostic failure must not create a second fault.
  }
  try {
    console.error(
      `[${kind}] ${details.errorStack || `${details.errorName}: ${details.errorMessage}`}`
    )
  } catch {
    // Custom console sinks must not defeat the safety guard.
  }
}

export function installUncaughtPipeErrorGuard(): void {
  const onUncaughtException = (error: unknown): void => {
    const errorCode = readErrorProperty(error, 'code')
    if (errorCode === 'EIO' || errorCode === 'EPIPE') {
      return
    }

    // #9441: the next rethrow leaves no macOS crash report; persist evidence first.
    recordFatalMainProcessError('main_uncaught_exception', error)
    process.off('uncaughtException', onUncaughtException)
    // Throwing inside the handler exits with status 7; rethrow next tick to retain the real stack.
    setImmediate(() => {
      throw error
    })
  }

  process.on('uncaughtException', onUncaughtException)
  removeBootstrapFatalExitGuard()
}

/** Node kills unhandled rejections by default; log and preserve other startup chains when one background restore task fails (#9441). */
export function installUnhandledRejectionLogging(): void {
  process.on('unhandledRejection', (reason) => {
    recordFatalMainProcessError('main_unhandled_rejection', reason)
  })
}
