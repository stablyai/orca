/**
 * Each paused pane's last working directory, read from the daemon's own checkpoint after quiesce
 * (mover design, section 3.3). It lives nowhere else: without it a pane would reopen on the host
 * at its worktree root, which is a silent loss.
 */
import type { ColdRestoreDetection } from '../../daemon/history-reader'
import { wslUncPathToLinux } from './wsl-move-path-rewriter'

export type WslMoveRestoreHint = { paneKey: string; cwd: string }

export type WslMoveRestoreHintPane = {
  paneKey: string
  sessionId: string
  /** The distro the pane's session ran in, as the daemon reported it; null for a native shell. */
  wslDistro?: string | null
}

export type WslMoveRestoreHintCapture = {
  hints: WslMoveRestoreHint[]
  /** Panes whose checkpoint could not be read; the preview names them, the move still runs. */
  unreadablePaneKeys: string[]
  /** Panes with no folder inside the moved distro to restore; they reopen at the workspace root. */
  noCwdPaneKeys: string[]
  /** Panes whose folder may be older than the last one the shell was in. */
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
  panes: readonly WslMoveRestoreHintPane[],
  distro: string
): Promise<WslMoveRestoreHintCapture> {
  const capture: WslMoveRestoreHintCapture = {
    hints: [],
    unreadablePaneKeys: [],
    noCwdPaneKeys: [],
    staleCwdPaneKeys: []
  }
  for (const pane of panes) {
    let detection: ColdRestoreDetection
    try {
      // A sleep ends the session cleanly; its checkpoint is exactly what a cold restore would read.
      detection = await reader.detectColdRestoreState(pane.sessionId, {
        ignoreCleanEnd: true,
        wslDistro: distro
      })
    } catch {
      capture.unreadablePaneKeys.push(pane.paneKey)
      continue
    }
    if (detection.status === 'unreadable') {
      capture.unreadablePaneKeys.push(pane.paneKey)
      continue
    }
    if (detection.status !== 'restored') {
      capture.noCwdPaneKeys.push(pane.paneKey)
      continue
    }
    const linux = hostLinuxCwd(detection.restoreInfo.cwd, pane, distro)
    if (!linux) {
      capture.noCwdPaneKeys.push(pane.paneKey)
      continue
    }
    capture.hints.push({ paneKey: pane.paneKey, cwd: linux })
    // A spawn-folder fallback is as stale as a checkpoint behind an unreadable log.
    if (detection.hasUnreadableRecovery || detection.cwdFromSpawn) {
      capture.staleCwdPaneKeys.push(pane.paneKey)
    }
  }
  return capture
}

// The bridge's UNC spelling, or a Linux path from a session known to run in the moved distro.
function hostLinuxCwd(cwd: string, pane: WslMoveRestoreHintPane, distro: string): string | null {
  const fromUnc = wslUncPathToLinux(cwd, distro)
  if (fromUnc) {
    return fromUnc
  }
  const ranInDistro =
    typeof pane.wslDistro === 'string' && pane.wslDistro.toLowerCase() === distro.toLowerCase()
  return ranInDistro && /^\/(?!\/)/.test(cwd) ? cwd : null
}
