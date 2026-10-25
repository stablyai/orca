import { isTrustedDesktopRenderer } from '../window/desktop-renderer-registry'

let trustedBrowserRendererWebContentsId: number | null = null

export function setTrustedBrowserRendererWebContentsId(webContentsId: number | null): void {
  trustedBrowserRendererWebContentsId = webContentsId
}

export function isTrustedBrowserRenderer(sender: Electron.WebContents): boolean {
  return isTrustedDesktopRenderer(sender, trustedBrowserRendererWebContentsId, true)
}
