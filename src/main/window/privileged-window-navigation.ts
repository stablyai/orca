import { shell, type WebContents } from 'electron'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { isRendererDocumentNavigation } from './renderer-document-navigation'

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
    // Allow own-document reloads or lazy-chunk recovery silently fails without an unload-prevented signal.
    if (isRendererDocumentNavigation(contents.getURL(), url)) {
      return
    }
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    event.preventDefault()
  })
}
