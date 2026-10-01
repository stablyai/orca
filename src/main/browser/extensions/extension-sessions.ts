import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { app, BrowserWindow, dialog, webContents, type Session } from 'electron'
import { translateMain } from '../../i18n/main-i18n'
import { installExtensionApiHost } from './extension-api-host'
import { setBrowserExtensionSessionEnabler } from './extension-session-enabler'
import { watchExtensionCookies } from './extension-cookies-api'
import {
  readDisabledExtensions,
  readInstalledExtensions,
  writeDisabledExtensions
} from './extension-install-folder'
// Each registers its chrome.* namespace with the API host.
import './extension-action'
import './extension-context-menus'
import './extension-downloads-api'
import './extension-manifest-api'
import './extension-native-messaging'
import './extension-notifications'
import './extension-privacy-api'
import './extension-tabs-api'
import './extension-web-navigation'

const sessions = new Set<Session>()
let installedChanged: () => void = () => {}

/** Where the Chrome Web Store installs extensions; every session loads from the same folder. */
export function browserExtensionsFolder(): string {
  return join(app.getPath('userData'), 'browser-extensions')
}

/** Called when an extension is installed, removed, turned on or off, or updated. */
export function setInstalledBrowserExtensionsChangedListener(listener: () => void): void {
  installedChanged = listener
}

/** Every extension-enabled session. */
export function browserExtensionSessions(): Session[] {
  return [...sessions]
}

async function load(sess: Session, path: string): Promise<void> {
  try {
    // The API host starts its service worker once it is ready.
    await sess.extensions.loadExtension(path)
  } catch (error) {
    console.error(`[browser-extensions] could not load ${path}:`, error)
  }
}

/** Keeps every session's set equal: a store install or update lands in one session only. */
function mirror(from: Session): void {
  from.extensions.on('extension-loaded', (_event, extension) => {
    for (const other of sessions) {
      if (other !== from && !other.extensions.getExtension(extension.id)) {
        void load(other, extension.path)
      }
    }
    installedChanged()
  })
  from.extensions.on('extension-unloaded', (_event, extension) => {
    for (const other of sessions) {
      if (other !== from && other.extensions.getExtension(extension.id)) {
        other.extensions.removeExtension(extension.id)
      }
    }
    installedChanged()
  })
}

/**
 * Gives a browser session Chrome extensions: Orca's chrome.* APIs, installs from the Chrome Web
 * Store (its "Add to Chrome" button works in Orca's browser), and the installed, enabled set.
 */
function enableBrowserExtensionsForSession(sess: Session): void {
  if (sessions.has(sess)) {
    return
  }
  const first = sessions.size === 0
  sessions.add(sess)
  installExtensionApiHost(sess, join(__dirname, 'browser-extension-api-preload.js'))
  watchExtensionCookies(sess)
  const folder = browserExtensionsFolder()
  // Why a dynamic import: the library imports Electron itself, which unit-tested graphs lack.
  void import('electron-chrome-web-store')
    .then(({ installChromeWebStore }) =>
      installChromeWebStore({
        session: sess,
        extensionsPath: folder,
        loadExtensions: false,
        // Why once: every session shares one extensions folder, so only one updater may write it.
        autoUpdate: first,
        beforeInstall: confirmInstall
      })
    )
    .then(async () => {
      const [installed, disabled] = await Promise.all([
        readInstalledExtensions(folder),
        readDisabledExtensions(folder)
      ])
      for (const extension of installed) {
        if (!disabled.has(extension.id) && !sess.extensions.getExtension(extension.id)) {
          await load(sess, extension.path)
        }
      }
      mirror(sess)
      installedChanged()
    })
    .catch((error: unknown) => console.error('[browser-extensions] setup failed:', error))
}

export async function setBrowserExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  const folder = browserExtensionsFolder()
  const disabled = await readDisabledExtensions(folder)
  if (enabled) {
    disabled.delete(id)
  } else {
    disabled.add(id)
  }
  await writeDisabledExtensions(folder, disabled)
  // One session is enough: mirror() carries the change to the rest.
  const [sess] = sessions
  const install = (await readInstalledExtensions(folder)).find((each) => each.id === id)
  if (!sess) {
    installedChanged()
  } else if (!enabled) {
    sess.extensions.removeExtension(id)
  } else if (install && !sess.extensions.getExtension(id)) {
    await load(sess, install.path)
  }
}

export async function removeBrowserExtension(id: string): Promise<void> {
  const [sess] = sessions
  if (sess?.extensions.getExtension(id)) {
    sess.extensions.removeExtension(id)
  }
  const folder = browserExtensionsFolder()
  await rm(join(folder, id), { recursive: true, force: true })
  const disabled = await readDisabledExtensions(folder)
  if (disabled.delete(id)) {
    await writeDisabledExtensions(folder, disabled)
  }
  installedChanged()
}

/** Asks before an "Add to Chrome" click installs, as Chrome does. */
async function confirmInstall(details: {
  localizedName: string
  icon: Electron.NativeImage
  frame: Electron.WebFrameMain
}): Promise<{ action: 'allow' | 'deny' }> {
  const guest = webContents.fromFrame(details.frame)
  const window = guest && BrowserWindow.fromWebContents(guest.hostWebContents ?? guest)
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    icon: details.icon,
    message: translateMain('auto.main.browser.browserExtensions.installTitle', 'Add "{{name}}"?', {
      name: details.localizedName
    }),
    detail: translateMain(
      'auto.main.browser.browserExtensions.installDetail',
      "It can read and change your data on the sites you visit in Orca's browser."
    ),
    buttons: [
      translateMain('auto.main.browser.browserExtensions.installConfirm', 'Add extension'),
      translateMain('auto.main.browser.browserExtensions.installCancel', 'Cancel')
    ],
    defaultId: 0,
    cancelId: 1
  }
  const { response } = await (window
    ? dialog.showMessageBox(window, options)
    : dialog.showMessageBox(options))
  return { action: response === 0 ? 'allow' : 'deny' }
}

setBrowserExtensionSessionEnabler(enableBrowserExtensionsForSession)
