import { webContents } from 'electron'

/** The registered guest page's contents while it is still alive. */
export function liveBrowserGuest(webContentsId: number): Electron.WebContents | null {
  const guest = webContents.fromId(webContentsId)
  return guest && !guest.isDestroyed() ? guest : null
}
