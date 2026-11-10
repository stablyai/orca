import { translateMain } from '../../../i18n/main-i18n'
import { dialog, type BrowserWindow } from 'electron'

// Main owns the file picker so a compromised renderer cannot request arbitrary file reads.
export async function pickCookieFile(parentWindow: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: translateMain('native.dialog.importCookies', 'Import Cookies'),
    filters: [
      { name: translateMain('native.dialog.cookieFiles', 'Cookie Files'), extensions: ['json'] },
      { name: translateMain('native.dialog.allFiles', 'All Files'), extensions: ['*'] }
    ],
    properties: ['openFile' as const]
  }
  const result = parentWindow
    ? await dialog.showOpenDialog(parentWindow, opts)
    : await dialog.showOpenDialog(opts)

  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
}
