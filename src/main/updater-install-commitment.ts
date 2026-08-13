import { BrowserWindow } from 'electron'
import { UPDATER_INSTALL_COMMITTED_CHANNEL } from '../shared/updater-install-events'

export { UPDATER_INSTALL_COMMITTED_CHANNEL }


// Why: the installer replaces app.asar while renderers are still alive, so every
// renderer needs to know — not just the one that pressed Restart. Renderer-local
// state cannot cross into the dashboard popout, which has its own JS context and
// its own lazy chunks. Main owns the fact and broadcasts it.
let installCommitted = false

export function isUpdaterInstallCommitted(): boolean {
  return installCommitted
}

function broadcast(committed: boolean): void {
  let windows: BrowserWindow[] = []
  try {
    windows = BrowserWindow.getAllWindows()
  } catch {
    return
  }
  for (const win of windows) {
    // Why: notifying renderers is best effort, but this runs inside the install
    // path — a window that is mid-teardown, or otherwise not what we expect, must
    // never be able to throw an update install into failure. Guard the whole
    // interaction, not just the send.
    try {
      if (win.isDestroyed()) {
        continue
      }
      win.webContents.send(UPDATER_INSTALL_COMMITTED_CHANNEL, committed)
    } catch {
      // Ignored deliberately; the renderer also seeds itself over IPC.
    }
  }
}

/**
 * Marked before the Linux package revalidation await, so an unrelated updater
 * check failing during that window cannot leave renderers believing no install
 * is under way while one proceeds.
 */
export function markUpdaterInstallCommitted(): void {
  installCommitted = true
  broadcast(true)
}

export function clearUpdaterInstallCommitted(): void {
  if (!installCommitted) {
    return
  }
  installCommitted = false
  broadcast(false)
}

export function resetUpdaterInstallCommitmentForTest(): void {
  installCommitted = false
}
