import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from '../codex/codex-home-paths'
import {
  isCodexBackfillIndexPending,
  readCodexStateDbBackfillStatus
} from '../codex/codex-state-db'
import type { CodexBackfillGateStatus } from '../../shared/codex-backfill-status-types'

/** The read-only lane slice this channel needs from CodexRuntimeHomeService. */
type CodexHomeLaneResolver = {
  isHostSystemDefaultRealHome: () => boolean
}

/**
 * Status of the codex home a FRESH local pane would read: the real ~/.codex on
 * the real-home lane, else the managed twin. Resume-pinned panes can differ;
 * the output-scanning detector remains their fallback net (#11828).
 */
export function getCodexBackfillGateStatus(
  runtimeHome: CodexHomeLaneResolver
): CodexBackfillGateStatus {
  const home = runtimeHome.isHostSystemDefaultRealHome()
    ? getSystemCodexHomePath()
    : getOrcaManagedCodexHomePath()
  if (!home || !isCodexBackfillIndexPending(home)) {
    return { pending: false, lastWatermark: null }
  }
  const status = readCodexStateDbBackfillStatus(home)
  return {
    pending: true,
    lastWatermark: status.kind === 'incomplete' ? status.lastWatermark : null
  }
}

/** Why: main-side per-pane holds now gate spawns; this global query has no renderer consumers and is retained for backward-compat pending a follow-up removal review. */
export function registerCodexBackfillStatusHandlers(runtimeHome: CodexHomeLaneResolver): void {
  ipcMain.removeHandler('codexBackfill:status')
  ipcMain.handle(
    'codexBackfill:status',
    (): CodexBackfillGateStatus => getCodexBackfillGateStatus(runtimeHome)
  )
}

export function broadcastCodexBackfillStatusChanged(
  getWindows: () => BrowserWindow[],
  status: CodexBackfillGateStatus
): void {
  for (const window of getWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) {
      continue
    }
    window.webContents.send('codexBackfill:statusChanged', status)
  }
}
