import { BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getChromeExtensionOrigin,
  isChromeExtensionId
} from '../../../shared/browser-extension-url'
import { getBrowserExtensionDnrStore } from './browser-extension-dnr-store'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import { getBrowserExtensionSyncStorageStore } from './browser-extension-sync-storage-store'

/** Where Chromium keeps chrome.storage.local, one folder per extension id (checked on disk). */
const EXTENSION_SETTINGS_FOLDER = 'Local Extension Settings'
/** Left in an uninstalled extension's open storage folder so the next launch deletes it. */
const UNINSTALLED_MARKER = 'orca-uninstalled'
const STORAGE_CLEAR_TIMEOUT_MS = 5_000
/** Extensions each session loaded this run; Chromium keeps their storage open until quit. */
const storageOpenedBySession = new WeakMap<Electron.Session, Set<string>>()

export function noteBrowserExtensionStorageOpened(
  sess: Electron.Session,
  extensionId: string
): void {
  const ids = storageOpenedBySession.get(sess) ?? new Set<string>()
  ids.add(extensionId)
  storageOpenedBySession.set(sess, ids)
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), STORAGE_CLEAR_TIMEOUT_MS)
    })
  ]).finally(() => clearTimeout(timer))
}

function storageFolder(sess: Electron.Session, extensionId: string): string | null {
  const storagePath = sess.getStoragePath()
  return storagePath ? join(storagePath, EXTENSION_SETTINGS_FOLDER, extensionId) : null
}

/** Its old chrome.storage.local is still open and waits for the next launch to delete it. */
function isStorageAwaitingRestart(sess: Electron.Session, extensionId: string): boolean {
  const folder = storageFolder(sess, extensionId)
  return folder !== null && existsSync(join(folder, UNINSTALLED_MARKER))
}

/** Why: Chromium would hand a reinstall the old chrome.storage.local it still holds open. */
export function throwIfBrowserExtensionStorageAwaitingRestart(
  sess: Electron.Session,
  extensionId: string
): void {
  if (isStorageAwaitingRestart(sess, extensionId)) {
    throw new Error("Restart Orca to finish removing this extension's old data, then try again")
  }
}

/**
 * Why through the extension's own API: Chromium keeps each extension's storage database open for
 * the rest of the run, so deleting its folder then would strand a reinstall's writes in unlinked
 * files. A hidden page of the still-loaded extension clears chrome.storage.local and .session.
 * A folder this run never opened is deleted directly; one opened earlier is marked for the launch sweep.
 */
async function clearExtensionStorage(sess: Electron.Session, extensionId: string): Promise<void> {
  if (!sess.extensions.getExtension(extensionId)) {
    const folder = storageFolder(sess, extensionId)
    if (!folder) {
      return
    }
    if (storageOpenedBySession.get(sess)?.has(extensionId)) {
      if (existsSync(folder)) {
        await writeFile(join(folder, UNINSTALLED_MARKER), '')
      }
    } else {
      await rm(folder, { recursive: true, force: true, maxRetries: 3 })
    }
    return
  }
  const window = new BrowserWindow({
    show: false,
    webPreferences: { session: sess, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  try {
    await withTimeout(
      window.loadURL(`${getChromeExtensionOrigin(extensionId)}/manifest.json`),
      'Opening the extension page'
    )
    await withTimeout(
      window.webContents.executeJavaScript(
        'Promise.all([globalThis.chrome?.storage?.local?.clear(), globalThis.chrome?.storage?.session?.clear()])'
      ),
      'Clearing extension storage'
    )
  } finally {
    window.destroy()
  }
}

/**
 * Uninstall wipes what the extension kept in one profile session, as Chrome does: chrome.storage
 * (call before unloading it), then its origin's IndexedDB, localStorage, caches and worker
 * registration.
 */
export async function clearBrowserExtensionSessionData(
  sess: Electron.Session,
  extensionId: string
): Promise<void> {
  if (!isChromeExtensionId(extensionId)) {
    throw new Error('Invalid extension id')
  }
  try {
    await clearExtensionStorage(sess, extensionId)
  } finally {
    await sess.clearStorageData({ origin: getChromeExtensionOrigin(extensionId) })
  }
}

/**
 * Attach-time cleanup, like Chrome's extension garbage collector: before anything opens them,
 * delete what uninstalled extensions left in this profile, including storage marked at uninstall
 * whose id was installed again since. Uninstall reaches only the profiles open then, so another
 * Orca profile's leftovers go here. A disabled extension keeps its data.
 */
export async function removeUninstalledBrowserExtensionData(
  sess: Electron.Session,
  profileId: string,
  installedIds: ReadonlySet<string>
): Promise<void> {
  getBrowserExtensionProfileStateStore().forgetExtensionsExcept(profileId, installedIds)
  getBrowserExtensionSyncStorageStore().forgetExtensionsExcept(profileId, installedIds)
  getBrowserExtensionDnrStore().forgetExtensionsExcept(profileId, installedIds)
  const storagePath = sess.getStoragePath()
  if (!storagePath) {
    return
  }
  const folder = join(storagePath, EXTENSION_SETTINGS_FOLDER)
  const entries = await readdir(folder).catch(() => [])
  const openThisRun = storageOpenedBySession.get(sess)
  await Promise.all(
    entries
      .filter(
        (name) =>
          isChromeExtensionId(name) &&
          !openThisRun?.has(name) &&
          (!installedIds.has(name) || isStorageAwaitingRestart(sess, name))
      )
      .map((name) => rm(join(folder, name), { recursive: true, force: true, maxRetries: 3 }))
  )
}
