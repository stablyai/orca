/**
 * Writes a startup command into a local PTY once the shell reports readiness.
 */
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
  // Why: only shells with bracketed-paste active (see isBracketedPasteSafeShell) accept the wrapper; others use the raw path so ESC[200~ isn't echoed.
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
    // Why: run in the same interactive shell (not `shell -c`) so the session survives after the agent exits.
    // Why CR on Windows: PSReadLine/cmd.exe submit on `\r`, not LF; POSIX treats either as Enter under ICRNL.
    const submit = process.platform === 'win32' ? '\r' : '\n'
    // Why: single write after the ready barrier avoids incremental-paste char drops; multiline is bracketed-paste wrapped so newlines don't submit early.
    proc.write(
      buildStartupCommandSubmission(startupCommand, {
        submit,
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
    // Why: marker fires from precmd before the line editor takes the PTY out of ECHO; writing now double-echoes the command, so settle first.
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
