import { installElectronNavigationWarningRedaction } from '../../browser/electron-navigation-warning-redaction'
import { recordDurableCrashBreadcrumb } from '../../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { removeBootstrapFatalExitGuard } from './bootstrap-fatal-exit-guard'
import { isNativePtyException } from '../../daemon/pty-subprocess/daemon-native-pty-exception'
import { quitAfterFatalException } from './fatal-exception-quit'

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

type StdioStream = Pick<NodeJS.WritableStream, 'on'>

/** Console output is diagnostic only; a dead terminal or full log volume must not fault main. */
export function installStdioWriteErrorSink(
  streams: readonly (readonly [name: string, stream: StdioStream | undefined])[] = [
    ['stdout', process.stdout],
    ['stderr', process.stderr]
  ]
): void {
  for (const [streamName, stream] of streams) {
    let failed = false
    // Node re-emits a failed sync write as an async 'error' event; console swallows only the first.
    // Stdio retries at most once per event-loop turn, so output resumes once space frees up.
    stream?.on('error', (error: unknown) => {
      if (failed) {
        return
      }
      failed = true
      try {
        // Not console: it writes to the stream that just failed.
        recordDurableCrashBreadcrumb('main_stdio_write_failed', {
          stream: streamName,
          errorCode: boundedString(readErrorProperty(error, 'code') ?? '', 100),
          // libuv has no name for some errnos (e.g. EDQUOT) and reports code UNKNOWN.
          errno: boundedString(readErrorProperty(error, 'errno') ?? '', 20)
        })
      } catch {
        // The log volume that failed may also hold the trace.
      }
    })
  }
}

// A hostile error (e.g. a throwing getter) must still reach the fatal path, not escape it.
function isBenignNativePtyFault(error: unknown): boolean {
  try {
    return isNativePtyException(error)
  } catch {
    return false
  }
}

// Stays installed for good: Electron's default handler shows a modal that blocks main until someone clicks OK.
export function installUncaughtExceptionQuitGuard(
  quit: () => void = quitAfterFatalException
): void {
  let quitting = false
  process.on('uncaughtException', (error: unknown): void => {
    const errorCode = readErrorProperty(error, 'code')
    // A local PTY that died under us is not a main-process fault (same rule as the daemon and orcad).
    if (errorCode === 'EIO' || errorCode === 'EPIPE' || isBenignNativePtyFault(error)) {
      return
    }
    // Faults during teardown (or while recording) are expected once main is broken; quit once.
    if (quitting) {
      return
    }
    quitting = true
    // #9441: persist evidence before the process exits.
    recordFatalMainProcessError('main_uncaught_exception', error)
    quit()
  })
  removeBootstrapFatalExitGuard()
}

/** Node kills unhandled rejections by default; log and preserve other startup chains when one background restore task fails (#9441). */
export function installUnhandledRejectionLogging(): void {
  installElectronNavigationWarningRedaction()
  process.on('unhandledRejection', (reason) => {
    recordFatalMainProcessError('main_unhandled_rejection', reason)
  })
}
