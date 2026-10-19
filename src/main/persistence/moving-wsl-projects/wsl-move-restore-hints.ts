/**
 * Each paused pane's last working directory, read from the daemon's own checkpoint after quiesce
 * (mover design, section 3.3). It lives nowhere else: without it a pane would reopen on the host
 * at its worktree root, which is a silent loss.
 */
import type { ColdRestoreDetection } from '../../daemon/history-reader'
import { wslUncPathToLinux } from './wsl-move-path-rewriter'

export type WslMoveRestoreHint = { paneKey: string; cwd: string }

export type WslMoveRestoreHintCapture = {
  hints: WslMoveRestoreHint[]
  /** Panes whose checkpoint could not be read; the preview names them, the move still runs. */
  unreadablePaneKeys: string[]
  /** Panes restored from a checkpoint whose newer log was unreadable, so the folder may be older. */
  staleCwdPaneKeys: string[]
}

type ColdRestoreReader = {
  detectColdRestoreState: (
    sessionId: string,
    opts?: { ignoreCleanEnd?: boolean; wslDistro?: string }
  ) => Promise<ColdRestoreDetection>
}

export async function captureWslMoveRestoreHints(
  reader: ColdRestoreReader,
  panes: readonly { paneKey: string; sessionId: string }[],
  distro: string
): Promise<WslMoveRestoreHintCapture> {
  const capture: WslMoveRestoreHintCapture = {
    hints: [],
    unreadablePaneKeys: [],
    staleCwdPaneKeys: []
  }
  for (const pane of panes) {
    // A sleep ends the session cleanly; its checkpoint is exactly what a cold restore would read.
    const detection = await reader.detectColdRestoreState(pane.sessionId, {
      ignoreCleanEnd: true,
      wslDistro: distro
    })
    if (detection.status === 'unreadable') {
      capture.unreadablePaneKeys.push(pane.paneKey)
      continue
    }
    if (detection.status !== 'restored') {
      continue
    }
    if (detection.hasUnreadableRecovery) {
      capture.staleCwdPaneKeys.push(pane.paneKey)
    }
    // The checkpoint holds the bridge's UNC spelling or the shell's own Linux path; only a path
    // inside the moved distro means anything on the host.
    const { cwd } = detection.restoreInfo
    const linux = wslUncPathToLinux(cwd, distro) ?? (/^\/(?!\/)/.test(cwd) ? cwd : null)
    if (linux) {
      capture.hints.push({ paneKey: pane.paneKey, cwd: linux })
    }
  }
  return capture
}
