import { BrowserWindow, dialog, type OpenDialogOptions, type WebContents } from 'electron'

export async function chooseManualGhosttyConfigPath(
  webContents?: WebContents
): Promise<string | null> {
  const ownerWindow = webContents ? BrowserWindow.fromWebContents(webContents) : null
  const options: OpenDialogOptions = {
    title: 'Import Ghostty Config',
    // Why: Ghostty's canonical config file is the extensionless `config`, which an
    // extension filter would grey out on macOS, so the picker stays unfiltered.
    properties: ['openFile']
  }
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0] ?? null
}
