import { BrowserWindow } from 'electron'

export function getMenuTargetWebContents(
  targetWindow?: Electron.BaseWindow | null
): Electron.WebContents | null {
  const candidate = targetWindow as
    | { webContents?: Electron.WebContents; isDestroyed?: () => boolean }
    | null
    | undefined
  if (candidate?.webContents && candidate.isDestroyed?.() !== true) {
    return candidate.webContents
  }
  return BrowserWindow.getFocusedWindow()?.webContents ?? null
}

export function reloadMenuTarget(
  targetWindow: Electron.BaseWindow | null | undefined,
  ignoreCache: boolean,
  onBeforeReload?: (options: { ignoreCache: boolean; webContentsId: number }) => void
): void {
  const webContents = getMenuTargetWebContents(targetWindow)
  if (!webContents) {
    return
  }

  onBeforeReload?.({ ignoreCache, webContentsId: webContents.id })

  if (ignoreCache) {
    webContents.reloadIgnoringCache()
    return
  }

  webContents.reload()
}
