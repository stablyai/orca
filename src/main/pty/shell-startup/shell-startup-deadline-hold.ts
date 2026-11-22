import type { PtySlaveLineEditorProbe } from '../../../shared/terminal/pty/native-process/pty-slave-line-discipline-echo'

// The ready marker normally ends the hold; polling only catches line editors that never print it.
const HOLD_PROBE_INTERVAL_MS = 500
// A shell reading in canonical mode (line editing disabled) never leaves it, so it still gets the command.
const HOLD_MAX_MS = 60_000

/**
 * Past the shell-ready deadline, keep startup input held while the PTY is still canonical: rc files are
 * running, and anything there that reads the terminal would swallow it (#18172). Releases at once when
 * line discipline cannot be read. Returns a cancel for the marker, exit and dispose paths.
 */
export function holdStartupInputWhileShellInitializes(
  probe: PtySlaveLineEditorProbe | undefined,
  release: () => void
): () => void {
  if (!probe) {
    release()
    return () => {}
  }
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
  const check = async (): Promise<void> => {
    const state = await probe().catch(() => 'unknown' as const)
    if (settled) {
      return
    }
    if (state !== 'canonical') {
      finish()
      return
    }
    pollTimer = setTimeout(() => {
      pollTimer = null
      void check()
    }, HOLD_PROBE_INTERVAL_MS)
  }
  void check()
  return cancel
}
