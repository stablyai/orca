import type { BrowserWindow } from 'electron'
import { isDashboardPopoutRenderer } from './dashboard-popout-window'

export type HelpMenuEventTarget = {
  window: BrowserWindow | null
  /** The pop-out invoked the item, so the caller must raise the main window before sending. */
  surfaceMainWindow: boolean
}

/**
 * Resolve which window receives a Help-menu `ui:` event.
 *
 * Why: only the main window mounts those renderer listeners, so an item clicked
 * while the dashboard pop-out is focused would otherwise be a silent no-op.
 */
export function resolveHelpMenuEventTarget(
  invokingWindow: BrowserWindow | null | undefined,
  mainWindow: BrowserWindow | null | undefined
): HelpMenuEventTarget {
  const liveMainWindow = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  if (!invokingWindow || invokingWindow.isDestroyed()) {
    return { window: liveMainWindow, surfaceMainWindow: false }
  }
  if (isDashboardPopoutRenderer(invokingWindow.webContents)) {
    return { window: liveMainWindow, surfaceMainWindow: true }
  }
  return { window: invokingWindow, surfaceMainWindow: false }
}
