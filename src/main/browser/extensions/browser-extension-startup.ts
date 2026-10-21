import { app, webContents } from 'electron'
import { BROWSER_EXTENSIONS_CHANGED_CHANNEL } from '../../../shared/browser-extension-types'
import {
  installBrowserExtensionApiHost,
  getBrowserExtensionProfileIdForSession
} from './browser-extension-api-host'
import {
  isBrowserExtensionSupportEnabled,
  setBrowserExtensionSupportEnabled
} from './browser-extension-support'
import { browserSessionRegistry } from '../browser-session-registry'
import {
  attachBrowserExtensionsToProfileSession,
  detachBrowserExtensionsFromAllProfileSessions
} from './browser-extension-session-loader'
import { notifyBrowserExtensionActionsChanged } from './browser-extension-action-registry'
import { registerBrowserExtensionNamespaces } from './register-browser-extension-namespaces'
import { observeBrowserExtensionTabLifecycle } from './api/tabs-lifecycle'
import { observeBrowserExtensionWebNavigation } from './api/web-navigation'
import { observeBrowserExtensionCommands } from './api/commands'
import { observeBrowserExtensionDnrContents } from './browser-extension-dnr-session'
import { installBrowserExtensionSessionServices } from './browser-extension-session-services'
import { installBrowserExtensionToolbarNotifications } from './browser-extension-toolbar'
import { installChromeWebStoreBridgeHost } from './browser-extension-webstore-bridge-host'
import { startBrowserExtensionUpdateChecks } from './browser-extension-webstore-updater'
import {
  notifyBrowserExtensionListChanged,
  setBrowserExtensionListChangedListener
} from './browser-extension-list-changes'
import { getBrowserExtensionMainWindow } from './browser-extension-window-model'
import {
  setSavedBrowserTabsSource,
  type SavedBrowserTabsSource
} from './browser-extension-discarded-tabs'

let initialized = false
let switching = Promise.resolve()

/** Runs before browser sessions are set up; with the setting off nothing is registered or loaded. */
export function initializeBrowserExtensionSupport(options: {
  enabled: boolean
  /** The saved workspace session, which names browser pages not loaded yet (discarded tabs). */
  savedBrowserTabs?: SavedBrowserTabsSource
}): void {
  setSavedBrowserTabsSource(options.savedBrowserTabs ?? null)
  setBrowserExtensionSupportEnabled(options.enabled)
  if (options.enabled) {
    installBrowserExtensionSupport()
  }
}

/**
 * The experimental setting changed while Orca runs. Off unloads every profile's extensions and
 * keeps their data; on loads them into every open profile, as a launch would.
 */
export function switchBrowserExtensionSupport(enabled: boolean): Promise<void> {
  // Why chained: an unload still in flight must finish before a load reuses the same sessions.
  switching = switching
    .then(async () => {
      if (enabled === isBrowserExtensionSupportEnabled()) {
        return
      }
      setBrowserExtensionSupportEnabled(enabled)
      if (enabled) {
        installBrowserExtensionSupport()
        for (const profile of browserSessionRegistry.listProfiles()) {
          attachBrowserExtensionsToProfileSession(
            profile,
            browserSessionRegistry.getEnabledExtensionIds(profile.id)
          )
        }
        // Why: tabs already open were created before their session ran extensions.
        webContents.getAllWebContents().forEach(observeExtensionContents)
      } else {
        await detachBrowserExtensionsFromAllProfileSessions()
      }
      notifyBrowserExtensionListChanged()
      for (const profile of browserSessionRegistry.listProfiles()) {
        notifyBrowserExtensionActionsChanged(profile.id)
      }
    })
    .catch((error: unknown) => {
      console.warn('[browser-extensions] Could not switch extension support:', error)
    })
  return switching
}

/** Process-wide hosts and listeners; each one checks per session, so they stay once installed. */
function installBrowserExtensionSupport(): void {
  if (initialized) {
    return
  }
  initialized = true
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
  app.on('web-contents-created', (_event, contents) => observeExtensionContents(contents))
}

const observedContents = new WeakSet<Electron.WebContents>()

/** Tabs (webview guests) and extension popouts in a session that runs extensions. */
function observeExtensionContents(contents: Electron.WebContents): void {
  const type = contents.getType()
  if (
    (type !== 'webview' && type !== 'window') ||
    observedContents.has(contents) ||
    !getBrowserExtensionProfileIdForSession(contents.session)
  ) {
    return
  }
  observedContents.add(contents)
  observeBrowserExtensionWebNavigation(contents)
  observeBrowserExtensionTabLifecycle(contents)
  observeBrowserExtensionDnrContents(contents)
  observeBrowserExtensionCommands(contents)
}
