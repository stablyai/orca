import { BrowserWindow } from 'electron'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getChromeExtensionOrigin,
  isChromeExtensionId
} from '../../../shared/browser-extension-url'

/** Where Chromium keeps chrome.storage.local, one folder per extension id (checked on disk). */
const EXTENSION_SETTINGS_FOLDER = 'Local Extension Settings'
const STORAGE_CLEAR_TIMEOUT_MS = 5_000

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
 * the rest of the run, so deleting its folder now would strand a reinstall's writes in unlinked
 * files. A hidden page of the still-loaded extension clears chrome.storage.local and .session.
 */
async function clearLoadedExtensionStorage(
  sess: Electron.Session,
  extensionId: string
): Promise<void> {
  if (!sess.extensions.getExtension(extensionId)) {
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
 * through the extension (call before unloading it), then its origin's IndexedDB, localStorage,
 * caches and worker registration. The emptied storage folder goes at the next launch.
 */
export async function clearBrowserExtensionSessionData(
  sess: Electron.Session,
  extensionId: string
): Promise<void> {
  if (!isChromeExtensionId(extensionId)) {
    throw new Error('Invalid extension id')
  }
  try {
    await clearLoadedExtensionStorage(sess, extensionId)
  } finally {
    await sess.clearStorageData({ origin: getChromeExtensionOrigin(extensionId) })
  }
}

/**
 * Launch-time cleanup, like Chrome's extension garbage collector: before anything opens them,
 * delete the chrome.storage folders of extensions no longer installed. Only folders named by an
 * extension id are touched; a disabled extension keeps its data.
 */
export async function removeOrphanedBrowserExtensionStorage(
  storagePath: string | null,
  installedIds: ReadonlySet<string>
): Promise<void> {
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
