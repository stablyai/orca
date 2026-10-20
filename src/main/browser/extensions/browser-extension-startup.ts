import { app } from 'electron'
import { BROWSER_EXTENSIONS_CHANGED_CHANNEL } from '../../../shared/browser-extension-types'
import {
  installBrowserExtensionApiHost,
  getBrowserExtensionProfileIdForSession
} from './browser-extension-api-host'
import { setBrowserExtensionSupportEnabled } from './browser-extension-support'
import { registerBrowserExtensionNamespaces } from './register-browser-extension-namespaces'
import { observeBrowserExtensionTabLifecycle } from './api/tabs-lifecycle'
import { observeBrowserExtensionWebNavigation } from './api/web-navigation'
import { observeBrowserExtensionCommands } from './api/commands'
import { installBrowserExtensionSessionServices } from './browser-extension-session-services'
import { installBrowserExtensionToolbarNotifications } from './browser-extension-toolbar'
import { installChromeWebStoreBridgeHost } from './browser-extension-webstore-bridge-host'
import { startBrowserExtensionUpdateChecks } from './browser-extension-webstore-updater'
import { setBrowserExtensionListChangedListener } from './browser-extension-list-changes'
import { getBrowserExtensionMainWindow } from './browser-extension-window-model'
import {
  setSavedBrowserTabsSource,
  type SavedBrowserTabsSource
} from './browser-extension-discarded-tabs'

let initialized = false

/** Runs before browser sessions are set up; with the setting off nothing is registered or loaded. */
export function initializeBrowserExtensionSupport(options: {
  enabled: boolean
  /** The saved workspace session, which names browser pages not loaded yet (discarded tabs). */
  savedBrowserTabs?: SavedBrowserTabsSource
}): void {
  setBrowserExtensionSupportEnabled(options.enabled)
  if (!options.enabled || initialized) {
    return
  }
  initialized = true
  setSavedBrowserTabsSource(options.savedBrowserTabs ?? null)
  registerBrowserExtensionNamespaces()
  installBrowserExtensionApiHost()
  installBrowserExtensionSessionServices()
  installBrowserExtensionToolbarNotifications()
  installChromeWebStoreBridgeHost()
  setBrowserExtensionListChangedListener(() => {
    const window = getBrowserExtensionMainWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(BROWSER_EXTENSIONS_CHANGED_CHANNEL)
    }
  })
  startBrowserExtensionUpdateChecks()
  app.on('web-contents-created', (_event, contents) => {
    const type = contents.getType()
    // Tabs (webview guests) and extension popouts in a session that runs extensions.
    if (
      (type !== 'webview' && type !== 'window') ||
      !getBrowserExtensionProfileIdForSession(contents.session)
    ) {
      return
    }
    observeBrowserExtensionWebNavigation(contents)
    observeBrowserExtensionTabLifecycle(contents)
    observeBrowserExtensionCommands(contents)
  })
}
