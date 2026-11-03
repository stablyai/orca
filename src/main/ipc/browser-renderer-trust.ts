import { isTrustedMainRendererSender } from './main-renderer-sender-trust'

let trustedBrowserRendererWebContentsId: number | null = null

export function setTrustedBrowserRendererWebContentsId(webContentsId: number | null): void {
  trustedBrowserRendererWebContentsId = webContentsId
}

export function isTrustedBrowserRenderer(sender: Electron.WebContents): boolean {
  return isTrustedMainRendererSender(sender, trustedBrowserRendererWebContentsId)
}
