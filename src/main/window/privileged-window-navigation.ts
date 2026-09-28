import { shell, type WebContents } from 'electron'
import { normalizeExternalBrowserUrl } from '../../shared/browser-url'
import { isRendererDocumentNavigation } from './renderer-document-navigation'

/** Keep remote documents from inheriting an Orca window's privileged preload. */
export function installPrivilegedWindowNavigationPolicy(contents: WebContents): void {
  contents.setWindowOpenHandler(({ url, frameName }) => {
    if (frameName === 'orca-floating-workspace' && url === 'about:blank#floating-workspace') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          title: 'Orca Floating Workspace',
          parent: null as unknown as Electron.BrowserWindow,
          width: 960,
          height: 640,
          minWidth: 420,
          minHeight: 280,
          autoHideMenuBar: true,
          // Why: stay hidden so the reveal can honor the launch policy —
          // show:true activates the window and steals OS focus in automated runs.
          show: false,
          webPreferences: {
            webviewTag: true,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            // Why: let restored popout media resume without a gesture; scoped here so ordinary tabs keep the default policy.
            autoplayPolicy: 'no-user-gesture-required'
          }
        }
      }
    }
    const externalUrl = normalizeExternalBrowserUrl(url)
    if (externalUrl) {
      void shell.openExternal(externalUrl)
    }
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    // Why: location.reload() is a renderer-initiated navigation, so blocking it here
    // silently kills the lazy-chunk recovery reload with no unload-prevented signal.
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
