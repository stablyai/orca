import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'node:path'
import { normalizeBrowserDownloadFilename } from '../../../../shared/browser-download-filename'

function suggestedName(url: string, filename: string | undefined): string {
  if (filename) {
    return filename
  }
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').at(-1)
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && last) {
      return decodeURIComponent(last)
    }
  } catch {
    // An unparsable name falls through to the default below.
  }
  return 'download'
}

/** chrome.downloads `saveAs`: the system save dialog, over the window the download belongs to. */
export async function chooseDownloadSavePath(
  owner: Electron.WebContents,
  url: string,
  filename: string | undefined
): Promise<string | null> {
  const parent = BrowserWindow.fromWebContents(owner.hostWebContents ?? owner)
  const options: Electron.SaveDialogOptions = {
    defaultPath: join(
      app.getPath('downloads'),
      normalizeBrowserDownloadFilename(suggestedName(url, filename), process.platform)
    )
  }
  const result = parent
    ? await dialog.showSaveDialog(parent, options)
    : await dialog.showSaveDialog(options)
  return result.canceled || !result.filePath ? null : result.filePath
}
