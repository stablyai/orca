// Restore the last checkpointed cwd after Sleep instead of silently reopening at the worktree root.
import type { ColdRestoreDetection } from '../../daemon/history-reader'
import { wslUncPathToLinux } from '../../../shared/wsl-paths'

export type WslMoveRestoreHint = { paneKey: string; cwd: string }

export type WslMoveRestoreHintPane = {
  paneKey: string
  sessionId: string
  /** Daemon-reported distro; null means a native shell. */
  wslDistro?: string | null
  /**
   * The folder the pane's shell was in, read inside the distro right before Sleep. Bash on the
   * bridge reports none, so without it the checkpoint keeps only the spawn folder.
   */
  shellCwd?: string
}

export type WslMoveRestoreHintCapture = {
  hints: WslMoveRestoreHint[]
  /** Preview warns, but unreadable checkpoints do not block the move. */
  unreadablePaneKeys: string[]
  /** No usable cwd in the moved distro; restore at workspace root. */
  noCwdPaneKeys: string[]
  /** Checkpoint may predate the shell's last cwd. */
  staleCwdPaneKeys: string[]
}

export type ColdRestoreReader = {
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
    const shellCwd = pane.shellCwd && /^\/(?!\/)/.test(pane.shellCwd) ? pane.shellCwd : null
    if (shellCwd) {
      capture.hints.push({ paneKey: pane.paneKey, cwd: shellCwd })
      continue
    }
    let detection: ColdRestoreDetection
    try {
      // Clean Sleep exits still need their cold-restore checkpoints.
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
    const linux = wslMoveHostLinuxCwd(detection.restoreInfo.cwd, pane, distro)
    if (!linux) {
      capture.noCwdPaneKeys.push(pane.paneKey)
      continue
    }
    capture.hints.push({ paneKey: pane.paneKey, cwd: linux })
    // Spawn-folder fallbacks are stale too.
    if (detection.hasUnreadableRecovery || detection.cwdFromSpawn) {
      capture.staleCwdPaneKeys.push(pane.paneKey)
    }
  }
  return capture
}

// Accept Linux spelling only with evidence the session ran in this distro.
export function wslMoveHostLinuxCwd(
  cwd: string,
  pane: WslMoveRestoreHintPane,
  distro: string
): string | null {
  const fromUnc = wslUncPathToLinux(cwd, distro)
  if (fromUnc) {
    return fromUnc
  }
  const ranInDistro =
    typeof pane.wslDistro === 'string' && pane.wslDistro.toLowerCase() === distro.toLowerCase()
  return ranInDistro && /^\/(?!\/)/.test(cwd) ? cwd : null
}
