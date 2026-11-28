import { createPtySlaveLineEditorProbe } from '../../../shared/terminal/pty/native-process/pty-slave-line-discipline-echo'
import { shellRunsForegroundChild } from '../../../shared/terminal/pty/native-process/shell-process-readiness'

// The ready marker normally ends the hold; polling only catches line editors that never print it.
const HOLD_PROBE_INTERVAL_MS = 500
// Agent launches give up at 60 s; the 15 s daemon deadline plus this cap stays well inside that.
const HOLD_MAX_MS = 30_000

/**
 * Past the shell-ready deadline, keep startup input held only on positive evidence that rc files are still
 * running: a child of the shell holds the PTY foreground (#18172). A write there is eaten by anything that
 * reads the terminal. The hold lasts while that is true or the PTY stays canonical; a shell with no such
 * child (a marker-less prompt, a PTY relay, an unidentified shell) is released at once, as before.
 * Returns a cancel for the marker, exit and dispose paths.
 */
export function holdStartupInputWhileShellInitializes(
  pty: { slavePath: string | undefined; shellPid: number | null },
  release: () => void
): () => void {
  const { slavePath, shellPid } = pty
  const lineEditor = createPtySlaveLineEditorProbe(slavePath)
  if (!lineEditor || !slavePath || !shellPid) {
    release()
    return () => {}
  }
  const rcRunsCommand = (): Promise<boolean> =>
    shellRunsForegroundChild(shellPid, slavePath).catch(() => false)
  let settled = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  const cancel = (): void => {
    settled = true
    clearTimeout(maxTimer)
    if (pollTimer) {
      clearTimeout(pollTimer)
      pollTimer = null
    }
  }
  const finish = (): void => {
    if (!settled) {
      cancel()
      release()
    }
  }
  const maxTimer = setTimeout(finish, HOLD_MAX_MS)
  const keepHolding = (holding: boolean): void => {
    if (settled) {
      return
    }
    if (!holding) {
      finish()
      return
    }
    pollTimer = setTimeout(() => {
      pollTimer = null
      void Promise.all([rcRunsCommand(), lineEditor().catch(() => 'unknown' as const)]).then(
        ([running, state]) => keepHolding(running || state === 'canonical')
      )
    }, HOLD_PROBE_INTERVAL_MS)
  }
  void rcRunsCommand().then(keepHolding)
  return cancel
}
