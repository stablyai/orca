// Survive rejected tasks and known-benign exceptions; unknown exceptions require bounded shutdown.
import process from 'node:process'
import { isNativePtyException } from '../daemon/daemon-native-pty-exception'
import { ORCAD_EXIT_FAILED } from './orcad-exit-code'
import type { OrcadShutdownTrigger } from './orcad-lifecycle'

// Cap rejection storms so logging cannot stall the server.
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
    // Broken stdio also rejects log writes; report it once.
    if (code === 'EPIPE' || code === 'EIO') {
      if (!stdioPipeErrorLogged) {
        stdioPipeErrorLogged = true
        safeLog(`[orcad] ignoring ${code} from a closed output pipe; continuing:`, error)
      }
      return
    }
    // An isolated native PTY failure need not terminate the host.
    if (isNativePtyException(error)) {
      safeLog('[orcad] native PTY exception; continuing:', error)
      return
    }
    safeLog('[orcad] uncaught exception (fatal); stopping:', error)
    const shutdown = requestShutdown()
    if (!shutdown) {
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
