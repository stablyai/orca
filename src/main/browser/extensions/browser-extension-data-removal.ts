import { BrowserWindow } from 'electron'
import { readdir, rm } from 'node:fs/promises'
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

/**
 * Why through the extension's own API: Chromium keeps each extension's storage database open for
 * the rest of the run, so deleting its folder then would strand a reinstall's writes in unlinked
 * files. A hidden page of the still-loaded extension clears chrome.storage.local and .session.
 * A folder this run never opened is deleted directly; one opened earlier waits for the launch sweep.
 */
async function clearExtensionStorage(sess: Electron.Session, extensionId: string): Promise<void> {
  if (!sess.extensions.getExtension(extensionId)) {
    const storagePath = sess.getStoragePath()
    if (storagePath && !storageOpenedBySession.get(sess)?.has(extensionId)) {
      await rm(join(storagePath, EXTENSION_SETTINGS_FOLDER, extensionId), {
        recursive: true,
        force: true,
        maxRetries: 3
      })
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
 * delete what extensions no longer installed left in this profile. Uninstall reaches only the
 * profiles open then, so another Orca profile's leftovers go here. A disabled extension keeps its data.
 */
export async function removeUninstalledBrowserExtensionData(
  storagePath: string | null,
  profileId: string,
  installedIds: ReadonlySet<string>
): Promise<void> {
  getBrowserExtensionProfileStateStore().forgetExtensionsExcept(profileId, installedIds)
  getBrowserExtensionSyncStorageStore().forgetExtensionsExcept(profileId, installedIds)
  getBrowserExtensionDnrStore().forgetExtensionsExcept(profileId, installedIds)
  if (!storagePath) {
    return
  }
  const folder = join(storagePath, EXTENSION_SETTINGS_FOLDER)
  const entries = await readdir(folder).catch(() => [])
  await Promise.all(
    entries
      .filter((name) => isChromeExtensionId(name) && !installedIds.has(name))
      .map((name) => rm(join(folder, name), { recursive: true, force: true, maxRetries: 3 }))
  )
}
