import { ipcMain, Menu, nativeTheme } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  StatusPillAgentRow,
  StatusPillAnswerResult,
  StatusPillPreferences,
  StatusPillSummary
} from '../../../shared/status-pill-preload-api'
import type { StatusPillRuntime } from './createStatusPillWindow'

export type StatusPillIpcArgs = {
  window: BrowserWindow
  onFocusMainWindow: () => void
  getSummary: () => StatusPillSummary
  getRows: () => StatusPillAgentRow[]
  runtime?: StatusPillRuntime
  warn: (message: string, error?: unknown) => void
}

export function attachStatusPillIpcListeners(args: StatusPillIpcArgs): () => void {
  const clickHandler = (): void => {
    args.onFocusMainWindow()
  }
  const contextMenuHandler = (): void => {
    // Why: V1 ships a minimal context menu; rich options (Pin to display,
    // Settings) land in a follow-up alongside the tray checkbox.
    try {
      Menu.buildFromTemplate([
        { label: 'Orca status pill', enabled: false },
        { type: 'separator' },
        {
          label: 'Hide pill',
          click: () => {
            // Why: send a self-message so the renderer can animate out before
            // the window is destroyed by the settings change.
            try {
              args.window.webContents.send('statusPill:requestHide')
            } catch {
              // Best-effort.
            }
          }
        }
      ]).popup()
    } catch {
      // Best-effort; right-click never blocks the pill.
    }
  }
  const snapshotHandler = (): StatusPillSummary => args.getSummary()
  const rowsHandler = (): StatusPillAgentRow[] => args.getRows()
  const prefsHandler = (): StatusPillPreferences => ({
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    // Why: main process cannot read the renderer's matchMedia. The pill
    // renderer queries prefers-reduced-motion itself on mount and merges
    // with this preference snapshot.
    prefersReducedMotion: false
  })
  const answerHandler = async (payload: unknown): Promise<StatusPillAnswerResult> =>
    answerAgentFromPill(payload, args)

  ipcMain.on('statusPill:click', clickHandler)
  ipcMain.on('statusPill:contextMenu', contextMenuHandler)
  ipcMain.handle('statusPill:getSnapshot', snapshotHandler)
  ipcMain.handle('statusPill:getAgentRows', rowsHandler)
  ipcMain.handle('statusPill:getInitialPreferences', prefsHandler)
  ipcMain.handle('statusPill:answerAgent', answerHandler)

  return () => {
    ipcMain.removeListener('statusPill:click', clickHandler)
    ipcMain.removeListener('statusPill:contextMenu', contextMenuHandler)
    ipcMain.removeHandler('statusPill:getSnapshot')
    ipcMain.removeHandler('statusPill:getAgentRows')
    ipcMain.removeHandler('statusPill:getInitialPreferences')
    ipcMain.removeHandler('statusPill:answerAgent')
  }
}

async function answerAgentFromPill(
  payload: unknown,
  args: StatusPillIpcArgs
): Promise<StatusPillAnswerResult> {
  // Why: validate the payload shape before touching the runtime so a
  // malformed request from a compromised pill renderer cannot trigger a
  // runtime error.
  if (!payload || typeof payload !== 'object') {
    return { accepted: false, error: 'pane_not_found' }
  }
  const { paneKey, raw } = payload as { paneKey?: unknown; raw?: unknown }
  if (typeof paneKey !== 'string' || paneKey.length === 0 || typeof raw !== 'string') {
    return { accepted: false, error: 'pane_not_found' }
  }
  if (!args.runtime) {
    args.warn('[status-pill] answerAgent received without a runtime')
    return { accepted: false, error: 'send_failed' }
  }
  // Why: only allow answering if the paneKey currently has a pending question
  // in the live snapshot. This stops a stale/broken pill renderer from
  // writing to arbitrary panes after the question has already cleared.
  const liveRow = args
    .getRows()
    .find((row) => row.paneKey === paneKey && typeof row.interactivePrompt === 'string')
  if (!liveRow) {
    return { accepted: false, error: 'pane_not_found' }
  }
  const handle = args.runtime.getAgentStatusTerminalHandleForPaneKey(paneKey)
  if (!handle) {
    return { accepted: false, error: 'terminal_not_writable' }
  }
  try {
    await args.runtime.sendTerminal(
      handle,
      { text: raw },
      { suffixFailureError: 'status-pill-answer' }
    )
    return { accepted: true }
  } catch (error) {
    args.warn('[status-pill] answerAgent sendTerminal failed', error)
    return { accepted: false, error: 'send_failed' }
  }
}
