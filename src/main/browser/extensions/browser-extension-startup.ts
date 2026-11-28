import { linkBrowserExtensionsToRouteSession } from './profile-sessions/browser-extension-route-sessions'
import { browserExtensionSourceProfileId } from './profile-sessions/browser-extension-route-profiles'
import { app, ipcMain, webContents } from 'electron'
import { isHiddenHelperContents } from '../hidden-helper-window'
import { BROWSER_EXTENSIONS_CHANGED_CHANNEL } from '../../../shared/browser/extensions/browser-extension-types'
import { BROWSER_EXTENSION_WEB_STORE_CHANNEL } from '../../../shared/browser/extensions/browser-extension-webstore'
import {
  installBrowserExtensionApiHost,
  getBrowserExtensionProfileIdForSession
} from './api-runtime/browser-extension-api-host'
import {
  isBrowserExtensionSupportEnabled,
  setBrowserExtensionSupportEnabled,
  takePendingSavedBrowserTabs
} from './browser-extension-support'
import { browserSessionRegistry } from '../sessions/profiles/browser-session-registry'
import { notifyBrowserExtensionActionsChanged } from './actions/browser-extension-action-registry'
import {
  setBrowserExtensionGrantedPermissionsLookup,
  setBrowserExtensionNamespaceLoader
} from './api-runtime/browser-extension-namespace-registry'
import { readBrowserExtensionProfileGrants } from './permissions/browser-extension-session-permissions'
import { setBrowserExtensionProfilePresence } from './profile-sessions/browser-extension-profile-presence'
import { observeBrowserExtensionTabLifecycle } from './tabs-and-windows/browser-extension-tab-lifecycle'
import { observeBrowserExtensionWebNavigation } from './api/web-navigation'
import { observeBrowserExtensionCommands } from './api/commands'
import { observeBrowserExtensionDnrContents } from './declarative-net-request/session/browser-extension-dnr-contents'
import { installBrowserExtensionSessionServices } from './profile-sessions/browser-extension-session-services'
import { installBrowserExtensionToolbarNotifications } from './actions/browser-extension-toolbar'
import {
  notifyBrowserExtensionListChanged,
  setBrowserExtensionListChangedListener
} from './installation/browser-extension-list-changes'
import { getBrowserExtensionMainWindow } from './tabs-and-windows/browser-extension-window-model'
import {
  installIdleBrowserExtensionProfiles,
  isBrowserExtensionPageContents,
  trackBrowserExtensionPage
} from './profile-sessions/browser-extension-idle-profiles'
import { isBrowserExtensionSidePanelGuest } from './side-panel/browser-extension-side-panel-guests'
import {
  setSavedBrowserTabsSource,
  type SavedBrowserTabsSource
} from './tabs-and-windows/browser-extension-discarded-tabs'

const FIRST_UPDATE_CHECK_DELAY_MS = 60_000

let initialized = false
let switching = Promise.resolve()
let savedBrowserTabs: SavedBrowserTabsSource | null = null

/** Runs before browser sessions are set up; with the setting off nothing is registered or loaded. */
export function initializeBrowserExtensionSupport(options: {
  enabled: boolean
  /** The saved workspace session, which names browser pages not loaded yet (discarded tabs). */
  savedBrowserTabs?: SavedBrowserTabsSource
}): void {
  void import('./profile-storage/browser-extension-retired-profile-storage')
    .then(({ removeRetiredBrowserExtensionProfileStorage }) =>
      removeRetiredBrowserExtensionProfileStorage()
    )
    .catch((error: unknown) => {
      console.warn('[browser-extensions] Could not remove retired profile storage:', error)
    })
  savedBrowserTabs = options.savedBrowserTabs ?? null
  setBrowserExtensionSupportEnabled(options.enabled)
  if (options.enabled) {
    installBrowserExtensionSupport()
  }
}

/**
 * The extensions setting changed while Orca runs. Off unloads every profile's extensions and
 * keeps their data; on loads them into each profile that has a page open.
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
        // Why: pages already open, server, SSH and This-device pages included, were created before extensions ran.
        for (const contents of webContents.getAllWebContents()) {
          const profileId =
            browserSessionRegistry.profileIdForSession(contents.session) ??
            linkBrowserExtensionsToRouteSession(contents.session)
          // A hidden helper, such as a cookie save's CDP target, is not a page.
          if (profileId && !isHiddenHelperContents(contents)) {
            browserSessionRegistry.attachExtensions(profileId)
          }
          observeExtensionContents(contents)
        }
      } else {
        const [
          { detachBrowserExtensionsFromAllProfileSessions },
          { forgetAllBrowserExtensionSessions }
        ] = await Promise.all([
          import('./profile-sessions/browser-extension-session-loader'),
          import('./profile-sessions/browser-extension-idle-resume')
        ])
        await detachBrowserExtensionsFromAllProfileSessions()
        forgetAllBrowserExtensionSessions()
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
  setSavedBrowserTabsSource(savedBrowserTabs ?? takePendingSavedBrowserTabs(), (profileId) =>
    browserSessionRegistry.resolveKnownPartition(profileId)
  )
  // An SSH or This-device page's instance lasts as long as its local profile.
  setBrowserExtensionProfilePresence(
    (profileId) =>
      browserSessionRegistry.getProfile(browserExtensionSourceProfileId(profileId)) !== null
  )
  setBrowserExtensionGrantedPermissionsLookup((extension, session) => {
    const profileId = getBrowserExtensionProfileIdForSession(session)
    return profileId
      ? readBrowserExtensionProfileGrants(profileId, extension.id).grantedPermissions
      : []
  })
  setBrowserExtensionNamespaceLoader(async () => {
    const { registerBrowserExtensionNamespaces } =
      await import('./register-browser-extension-namespaces')
    registerBrowserExtensionNamespaces()
  })
  installBrowserExtensionApiHost()
  installBrowserExtensionSessionServices()
  installBrowserExtensionToolbarNotifications()
  ipcMain.removeHandler(BROWSER_EXTENSION_WEB_STORE_CHANNEL)
  ipcMain.handle(BROWSER_EXTENSION_WEB_STORE_CHANNEL, async (event, request: unknown) => {
    const { handleChromeWebStoreBridgeRequest } =
      await import('./web-store/browser-extension-webstore-bridge-host')
    return handleChromeWebStoreBridgeRequest(event, request)
  })
  setBrowserExtensionListChangedListener(() => {
    const window = getBrowserExtensionMainWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(BROWSER_EXTENSIONS_CHANGED_CHANNEL)
    }
  })
  setTimeout(() => {
    void import('./web-store/browser-extension-webstore-updater')
      .then(({ startBrowserExtensionUpdateChecks }) => {
        startBrowserExtensionUpdateChecks({ runImmediately: true })
      })
      .catch((error: unknown) => {
        console.warn('[browser-extensions] Could not start update checks:', error)
      })
  }, FIRST_UPDATE_CHECK_DELAY_MS).unref()
  installIdleBrowserExtensionProfiles(observeExtensionContents)
  // Why synchronous: loadURL right after construction emits did-start-loading before a microtask runs.
  app.on('web-contents-created', (_event, contents) => observeExtensionContents(contents))
}

const observedContents = new WeakSet<Electron.WebContents>()

/** Tabs (webview guests and serve's offscreen pages) and extension popouts in a session that runs extensions. */
function observeExtensionContents(contents: Electron.WebContents): void {
  const profileId = getBrowserExtensionProfileIdForSession(contents.session)
  if (!isBrowserExtensionPageContents(contents) || observedContents.has(contents) || !profileId) {
    return
  }
  observedContents.add(contents)
  trackBrowserExtensionPage(profileId, contents)
  // Side panels are extension views, not tabs: no tab or webNavigation events, but DNR and commands.
  if (!isBrowserExtensionSidePanelGuest(contents)) {
    observeBrowserExtensionWebNavigation(contents)
    observeBrowserExtensionTabLifecycle(contents)
  }
  observeBrowserExtensionDnrContents(contents)
  observeBrowserExtensionCommands(contents)
}
