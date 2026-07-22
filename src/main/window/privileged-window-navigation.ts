import { shell, type WebContents } from 'electron'
import { is } from '@electron-toolkit/utils'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'

/** Keep remote documents from inheriting an Orca window's privileged preload. */
export function installPrivilegedWindowNavigationPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url }) => {
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      if (is.dev && process.env.ELECTRON_RENDERER_URL) {
        try {
          const target = new URL(externalUrl)
          const allowed = new URL(process.env.ELECTRON_RENDERER_URL)
          if (target.origin === allowed.origin) {
            return
          }
        } catch {
          // Fall through and block malformed navigation targets.
        }
      }
      void shell.openExternal(externalUrl)
    }
    event.preventDefault()
  })
}
