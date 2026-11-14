import { BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from 'electron'

export async function chooseTerminalConfigFile(
  title: string,
  webContents?: WebContents
): Promise<string | null> {
  const ownerWindow = webContents ? BrowserWindow.fromWebContents(webContents) : null
  const options: OpenDialogOptions = {
    title,
    // Unfiltered: canonical configs are often extensionless, and they usually live in dot-directories.
    properties: ['openFile', 'showHiddenFiles']
  }
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : (result.filePaths[0] ?? null)
}
