import { webContents } from 'electron'

/**
 * The focused WebContents when it is not the window's own renderer — DevTools or a
 * guest view owns the Edit action even though the accelerator fired app-wide.
 */
export function resolveEditMenuTarget(
  focusedWindow: Electron.BrowserWindow
): Electron.WebContents | null {
  const focusedContents = webContents.getFocusedWebContents()
  if (focusedContents && focusedContents !== focusedWindow.webContents) {
    return focusedContents
  }
  return null
}
