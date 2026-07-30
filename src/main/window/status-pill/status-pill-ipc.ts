import { ipcMain, Menu, nativeTheme } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  StatusPillAgentRow,
  StatusPillAnswerResult,
  StatusPillFocusTarget,
  StatusPillPreferences,
  StatusPillSummary
} from '../../../shared/status-pill-preload-api'
import type { StatusPillRuntime } from './createStatusPillWindow'

export type StatusPillIpcArgs = {
  window: BrowserWindow
  onFocusMainWindow: () => void
  /** Focus a specific agent pane in the main window (used by row clicks in the
   *  expanded panel). The target is validated against the live rows before the
   *  callback fires so a stale renderer cannot focus arbitrary panes. */
  onFocusPane: (target: StatusPillFocusTarget) => void
  getSummary: () => StatusPillSummary
  getRows: () => StatusPillAgentRow[]
  runtime?: StatusPillRuntime
  /** Disable the pill (called by the "Hide pill" context-menu item). Main
   *  wires this to flipping experimentalFloatingStatusPill=false, which the
   *  coordinator reacts to by destroying the window. */
  onHidePill: () => void
  /** Read the pill window's current screen origin (for the drag start point). */
  getWindowPosition: () => { x: number; y: number }
  /** Move the pill window to a screen origin and (debounced) persist it. */
  setWindowPosition: (position: { x: number; y: number }) => void
  /** Receive the renderer's interactive content rect (relative to the window
   *  top-left) so main can hit-test the global cursor and toggle click-through. */
  onContentRect: (rect: { left: number; top: number; width: number; height: number }) => void
  /** Lock/unlock capture for the duration of a pointer press (drag safety). */
  onSetCapturing: (capturing: boolean) => void
  /** Tell main the island is expanded (forces full capture while expanded). */
  onSetExpanded: (expanded: boolean) => void
  warn: (message: string, error?: unknown) => void
}

/** Register all `statusPill:*` IPC handlers (click, context menu, snapshot
 *  pull, answer push). Returns a detach function that removes every listener
 *  and handler — call on window destroy. */
export function attachStatusPillIpcListeners(args: StatusPillIpcArgs): () => void {
  const clickHandler = (): void => {
    args.onFocusMainWindow()
  }
  const contextMenuHandler = (): void => {
    // Why: V1 ships a minimal context menu; rich options (Pin to display,
    // Settings) land in a follow-up alongside the tray checkbox.
    try {
      // Why: the pill BrowserWindow is `focusable: false`, so Menu.popup()
      // without an explicit `window` would attach to the OS-focused window
      // (almost always the wrong one). Pass the pill window explicitly.
      Menu.buildFromTemplate([
        { label: 'Orca status pill', enabled: false },
        { type: 'separator' },
        {
          label: 'Hide pill',
          click: () => {
            // Why: flip the setting off rather than message the renderer — the
            // coordinator reacts to the settings change and tears the window
            // down, and the choice persists across restarts.
            try {
              args.onHidePill()
            } catch {
              // Best-effort.
            }
          }
        }
      ]).popup({ window: args.window })
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
  const windowPositionHandler = (): { x: number; y: number } => args.getWindowPosition()
  const setWindowPositionHandler = (payload: unknown): void => {
    if (!payload || typeof payload !== 'object') {
      return
    }
    const { x, y } = payload as { x?: unknown; y?: unknown }
    if (typeof x !== 'number' || typeof y !== 'number') {
      return
    }
    args.setWindowPosition({ x, y })
  }
  // Why: the renderer reports its interactive content rect (relative to the
  // window top-left) whenever it resizes. Main offsets it by the live window
  // origin and hit-tests the global cursor against it to toggle click-through
  // (see createStatusPillWindow). This is how the tall transparent overlay
  // stays click-through everywhere except over the actual pill/panel.
  const contentRectHandler = (payload: unknown): void => {
    if (!payload || typeof payload !== 'object') {
      return
    }
    const { left, top, width, height } = payload as {
      left?: unknown
      top?: unknown
      width?: unknown
      height?: unknown
    }
    if (
      typeof left !== 'number' ||
      typeof top !== 'number' ||
      typeof width !== 'number' ||
      typeof height !== 'number'
    ) {
      return
    }
    args.onContentRect({ left, top, width, height })
  }
  const setCapturingHandler = (payload: unknown): void => {
    args.onSetCapturing(payload === true)
  }
  const setExpandedHandler = (payload: unknown): void => {
    args.onSetExpanded(payload === true)
  }
  const answerHandler = async (payload: unknown): Promise<StatusPillAnswerResult> =>
    answerAgentFromPill(payload, args)
  // Why: validate the focus target against the live rows so a stale or
  // compromised pill renderer cannot drive focus to a pane that no longer
  // exists. Focus is less destructive than answering, but still scoped.
  const focusPaneHandler = (payload: unknown): void => {
    if (!payload || typeof payload !== 'object') {
      return
    }
    const { paneKey, worktreeId } = payload as { paneKey?: unknown; worktreeId?: unknown }
    if (typeof paneKey !== 'string' || paneKey.length === 0) {
      return
    }
    const liveRow = args.getRows().find((row) => row.paneKey === paneKey)
    if (!liveRow) {
      return
    }
    args.onFocusPane({
      paneKey,
      worktreeId: typeof worktreeId === 'string' ? worktreeId : (liveRow.worktreeId ?? null)
    })
  }

  ipcMain.on('statusPill:click', clickHandler)
  ipcMain.on('statusPill:contextMenu', contextMenuHandler)
  ipcMain.on('statusPill:focusPane', focusPaneHandler)
  ipcMain.on('statusPill:setWindowPosition', setWindowPositionHandler)
  ipcMain.on('statusPill:contentRect', contentRectHandler)
  ipcMain.on('statusPill:setCapturing', setCapturingHandler)
  ipcMain.on('statusPill:setExpanded', setExpandedHandler)
  ipcMain.handle('statusPill:getSnapshot', snapshotHandler)
  ipcMain.handle('statusPill:getAgentRows', rowsHandler)
  ipcMain.handle('statusPill:getInitialPreferences', prefsHandler)
  ipcMain.handle('statusPill:getWindowPosition', windowPositionHandler)
  ipcMain.handle('statusPill:answerAgent', answerHandler)

  return () => {
    ipcMain.removeListener('statusPill:click', clickHandler)
    ipcMain.removeListener('statusPill:contextMenu', contextMenuHandler)
    ipcMain.removeListener('statusPill:focusPane', focusPaneHandler)
    ipcMain.removeListener('statusPill:setWindowPosition', setWindowPositionHandler)
    ipcMain.removeListener('statusPill:contentRect', contentRectHandler)
    ipcMain.removeListener('statusPill:setCapturing', setCapturingHandler)
    ipcMain.removeListener('statusPill:setExpanded', setExpandedHandler)
    ipcMain.removeHandler('statusPill:getSnapshot')
    ipcMain.removeHandler('statusPill:getAgentRows')
    ipcMain.removeHandler('statusPill:getInitialPreferences')
    ipcMain.removeHandler('statusPill:getWindowPosition')
    ipcMain.removeHandler('statusPill:answerAgent')
  }
}

/** Validate and route an answer from the pill renderer to the agent PTY.
 *  Returns accepted=false if the payload is malformed, the pane has no live
 *  pending prompt, or the runtime write fails. */
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
