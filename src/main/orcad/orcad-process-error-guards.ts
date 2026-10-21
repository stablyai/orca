/**
 * Process-level error guards for orcad, which runs the desktop runtime on plain Node.
 *
 * Why: Node's default exits on any unhandled rejection, so one failed fire-and-forget chain
 * (an SSH reconnect, a persistence write) would kill the server and every hosted terminal
 * (desktop issue #9441). Rejections and known-benign exceptions are logged and survived; any
 * other uncaught exception leaves state unknown, so it runs the bounded graceful stop and exits
 * non-zero with the reason logged.
 */
import process from 'node:process'
import { isNativePtyException } from '../daemon/daemon-native-pty-exception'
import { ORCAD_EXIT_FAILED } from './orcad-exit-code'
import type { OrcadShutdownTrigger } from './orcad-lifecycle'

// Why capped: one broken resource can reject hundreds of chains at once; log volume must not stall.
const REJECTION_LOG_WINDOW_MS = 60_000
const REJECTION_LOG_WINDOW_MAX = 20

function readCode(error: unknown): unknown {
  try {
    return error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined
  } catch {
    return undefined
  }
}

function safeLog(...args: unknown[]): void {
  try {
    console.error(...args)
  } catch {
    // A broken stderr must not turn a logged fault into a second one.
  }
}

export function installOrcadProcessErrorGuards(
  requestShutdown: () => OrcadShutdownTrigger | null,
  now: () => number = Date.now
): () => void {
  let windowStartedAt = 0
  let windowCount = 0
  let suppressed = 0
  let stdioPipeErrorLogged = false

  const onUnhandledRejection = (reason: unknown): void => {
    const at = now()
    if (at < windowStartedAt || at - windowStartedAt >= REJECTION_LOG_WINDOW_MS) {
      windowStartedAt = at
      windowCount = 0
    }
    if (windowCount >= REJECTION_LOG_WINDOW_MAX) {
      suppressed += 1
      return
    }
    windowCount += 1
    const note = suppressed > 0 ? ` (${suppressed} more suppressed since the last report)` : ''
    suppressed = 0
    safeLog(`[orcad] unhandled rejection; continuing${note}:`, reason)
  }

  const onUncaughtException = (error: unknown): void => {
    const code = readCode(error)
    // Why logged once: a closed stdio pipe fails every later write, including this log line.
    if (code === 'EPIPE' || code === 'EIO') {
      if (!stdioPipeErrorLogged) {
        stdioPipeErrorLogged = true
        safeLog(`[orcad] ignoring ${code} from a closed output pipe; continuing:`, error)
      }
      return
    }
    // The PTY is already dead; the server is still healthy (same policy as the terminal daemon).
    if (isNativePtyException(error)) {
      safeLog('[orcad] native PTY exception; continuing:', error)
      return
    }
    safeLog('[orcad] uncaught exception (fatal); stopping:', error)
    const shutdown = requestShutdown()
    if (!shutdown) {
      // Before the stop trigger exists there is nothing to flush.
      process.exit(ORCAD_EXIT_FAILED)
      return
    }
    if (!shutdown('uncaught exception', undefined, ORCAD_EXIT_FAILED)) {
      safeLog('[orcad] a stop is already in progress; it bounds the exit')
    }
  }

  process.on('unhandledRejection', onUnhandledRejection)
  process.on('uncaughtException', onUncaughtException)
  return () => {
    process.off('unhandledRejection', onUnhandledRejection)
    process.off('uncaughtException', onUncaughtException)
  }
}
