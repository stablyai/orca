import type * as pty from 'node-pty'
import { buildStartupCommandSubmission } from '../../shared/startup-command-submission'

export const STARTUP_COMMAND_READY_MAX_WAIT_MS = 1500
const POST_SHELL_READY_STARTUP_COMMAND_DELAY_MS = 30
const POST_SHELL_READY_STARTUP_COMMAND_FALLBACK_MS = 200

export type ShellReadySignal = {
  postMarkerBytesObserved: boolean
}

export function writeStartupCommandWhenShellReady(
  readyPromise: Promise<void | ShellReadySignal>,
  proc: pty.IPty,
  startupCommand: string,
  onExit: (cleanup: () => void) => void,
  // Only shells with active bracketed paste accept its escape wrapper without echoing it.
  options: { bracketedPasteSafe?: boolean } = {}
): void {
  let sent = false
  let postReadyTimer: ReturnType<typeof setTimeout> | null = null
  let postReadyDataDisposable: { dispose: () => void } | null = null

  const cleanup = (): void => {
    sent = true
    if (postReadyTimer !== null) {
      clearTimeout(postReadyTimer)
      postReadyTimer = null
    }
    postReadyDataDisposable?.dispose()
    postReadyDataDisposable = null
  }

  const flush = (): void => {
    if (sent) {
      return
    }
    sent = true
    postReadyDataDisposable?.dispose()
    postReadyDataDisposable = null
    if (postReadyTimer !== null) {
      clearTimeout(postReadyTimer)
      postReadyTimer = null
    }
    // Keep the interactive shell alive after agent exit; write once past readiness to avoid incremental-paste drops.
    proc.write(
      buildStartupCommandSubmission(startupCommand, {
        bracketedPasteSafe: options.bracketedPasteSafe === true
      })
    )
  }

  const schedulePostReadyFlush = (): void => {
    postReadyTimer = setTimeout(flush, POST_SHELL_READY_STARTUP_COMMAND_DELAY_MS)
  }

  readyPromise.then((signal) => {
    if (sent) {
      return
    }
    // precmd can fire before the line editor disables ECHO; wait for post-marker activity to prevent double echo.
    if (signal?.postMarkerBytesObserved === true) {
      schedulePostReadyFlush()
      return
    }
    postReadyDataDisposable = proc.onData(() => {
      postReadyDataDisposable?.dispose()
      postReadyDataDisposable = null
      if (postReadyTimer !== null) {
        clearTimeout(postReadyTimer)
      }
      schedulePostReadyFlush()
    })
    postReadyTimer = setTimeout(() => {
      postReadyDataDisposable?.dispose()
      postReadyDataDisposable = null
      postReadyTimer = null
      flush()
    }, POST_SHELL_READY_STARTUP_COMMAND_FALLBACK_MS)
  })
  onExit(cleanup)
}
