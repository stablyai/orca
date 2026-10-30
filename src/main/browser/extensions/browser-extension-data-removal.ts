import { existsSync } from 'node:fs'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  getChromeExtensionOrigin,
  isChromeExtensionId
} from '../../../shared/browser-extension-url'
import { runBrowserExtensionNativePage } from './browser-extension-native-page'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
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
const storageAwaitingRestartBySession = new WeakMap<Electron.Session, Set<string>>()
const sweepsBySession = new WeakMap<Electron.Session, Promise<unknown>>()

export function noteBrowserExtensionStorageOpened(
  sess: Electron.Session,
  extensionId: string
): void {
  const ids = storageOpenedBySession.get(sess) ?? new Set<string>()
  ids.add(extensionId)
  storageOpenedBySession.set(sess, ids)
}

function storageFolder(sess: Electron.Session, extensionId: string): string | null {
  const storagePath = sess.getStoragePath()
  return storagePath ? join(storagePath, EXTENSION_SETTINGS_FOLDER, extensionId) : null
}

/** Its old chrome.storage.local is still open and waits for the next launch to delete it. */
function isStorageAwaitingRestart(sess: Electron.Session, extensionId: string): boolean {
  const folder = storageFolder(sess, extensionId)
  return (
    storageAwaitingRestartBySession.get(sess)?.has(extensionId) === true ||
    (folder !== null && existsSync(join(folder, UNINSTALLED_MARKER)))
  )
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

async function markStorageAwaitingRestart(
  sess: Electron.Session,
  extensionId: string
): Promise<void> {
  const ids = storageAwaitingRestartBySession.get(sess) ?? new Set<string>()
  ids.add(extensionId)
  storageAwaitingRestartBySession.set(sess, ids)
  const folder = storageFolder(sess, extensionId)
  if (folder && existsSync(folder)) {
    await writeFile(join(folder, UNINSTALLED_MARKER), '')
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
    if (storageOpenedBySession.get(sess)?.has(extensionId)) {
      await markStorageAwaitingRestart(sess, extensionId)
    } else if (folder) {
      await rm(folder, { recursive: true, force: true, maxRetries: 3 })
    }
    return
  }
  await markStorageAwaitingRestart(sess, extensionId)
  try {
    await runBrowserExtensionNativePage({
      session: sess,
      extensionId,
      code: 'Promise.all([globalThis.chrome?.storage?.local?.clear(), globalThis.chrome?.storage?.session?.clear()])',
      timeoutMs: STORAGE_CLEAR_TIMEOUT_MS
    })
  } finally {
    await markStorageAwaitingRestart(sess, extensionId)
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

/** Profile deletion also reaches disabled extensions whose native settings Chromium kept open. */
export async function clearBrowserExtensionProfileSessionData(
  sess: Electron.Session
): Promise<void> {
  const storagePath = sess.getStoragePath()
  const entries = storagePath
    ? await readdir(join(storagePath, EXTENSION_SETTINGS_FOLDER)).catch(() => [])
    : []
  const ids = new Set([
    ...sess.extensions.getAllExtensions().map((extension) => extension.id),
    ...entries.filter(isChromeExtensionId)
  ])
  await Promise.all([...ids].map((id) => clearBrowserExtensionSessionData(sess, id)))
}

/**
 * Attach-time cleanup, like Chrome's extension garbage collector: before anything opens them,
 * delete what uninstalled extensions left in this profile, including storage marked at uninstall
 * whose id was installed again since. Uninstall reaches only the profiles open then, so another
 * Orca profile's leftovers go here. A disabled extension keeps its data.
 */
export function removeUninstalledBrowserExtensionData(
  sess: Electron.Session,
  profileId: string,
  installedIds: ReadonlySet<string>,
  onUninstalled?: (extensionIds: ReadonlySet<string>) => void
): Promise<ReadonlySet<string>> {
  return queueDataRemoval(sess, () =>
    removeUninstalledData(sess, profileId, { installedIds, onUninstalled })
  )
}

/** An explicit reinstall reconciles its own data while other additions may still be loading. */
export function removeReinstalledBrowserExtensionData(
  sess: Electron.Session,
  profileId: string,
  extensionId: string
): Promise<ReadonlySet<string>> {
  return queueDataRemoval(sess, () => removeUninstalledData(sess, profileId, { extensionId }))
}

function queueDataRemoval(
  sess: Electron.Session,
  remove: () => Promise<ReadonlySet<string>>
): Promise<ReadonlySet<string>> {
  const sweep = (sweepsBySession.get(sess) ?? Promise.resolve()).catch(() => {}).then(remove)
  sweepsBySession.set(sess, sweep)
  return sweep
}

type RemovalScope =
  | { installedIds: ReadonlySet<string>; onUninstalled?: (ids: ReadonlySet<string>) => void }
  | { extensionId: string }

async function removeUninstalledData(
  sess: Electron.Session,
  profileId: string,
  scope: RemovalScope
): Promise<ReadonlySet<string>> {
  const states = getBrowserExtensionProfileStateStore()
  const previousIds = Object.keys(states.readProfile(profileId)).filter(isChromeExtensionId)
  const allRemovals = getBrowserExtensionInstallStore().removalGenerations()
  const removals = new Map(
    [...allRemovals].filter(([id]) => !('extensionId' in scope) || id === scope.extensionId)
  )
  const stale = new Set(
    [...removals]
      .filter(([id, generation]) => states.read(profileId, id).removalGeneration !== generation)
      .map(([id]) => id)
  )
  const storagePath = sess.getStoragePath()
  const folder = storagePath ? join(storagePath, EXTENSION_SETTINGS_FOLDER) : null
  const removed = new Set(stale)
  if ('extensionId' in scope) {
    if (stale.has(scope.extensionId)) {
      states.forgetProfileExtension(profileId, scope.extensionId)
      getBrowserExtensionSyncStorageStore().forgetProfileExtension(profileId, scope.extensionId)
      getBrowserExtensionDnrStore().forgetProfileExtension(profileId, scope.extensionId)
    }
  } else {
    const retained = new Set([...scope.installedIds].filter((id) => !stale.has(id)))
    states.forgetExtensionsExcept(
      profileId,
      new Set([...retained, ...[...removals.keys()].filter((id) => !stale.has(id))])
    )
    getBrowserExtensionSyncStorageStore().forgetExtensionsExcept(profileId, retained)
    getBrowserExtensionDnrStore().forgetExtensionsExcept(profileId, retained)
    const entries = folder ? await readdir(folder).catch(() => []) : []
    for (const id of [
      ...previousIds.filter((id) => !scope.installedIds.has(id) && !removals.has(id)),
      ...entries.filter(
        (id) =>
          isChromeExtensionId(id) &&
          (!scope.installedIds.has(id) || isStorageAwaitingRestart(sess, id))
      )
    ]) {
      removed.add(id)
    }
  }
  const openThisRun = storageOpenedBySession.get(sess)
  await Promise.all(
    [...removed].map(async (id) => {
      await (openThisRun?.has(id)
        ? clearBrowserExtensionSessionData(sess, id)
        : sess.clearStorageData({ origin: getChromeExtensionOrigin(id) }))
      if (folder && !openThisRun?.has(id)) {
        await rm(join(folder, id), { recursive: true, force: true, maxRetries: 3 })
      }
    })
  )
  if ('installedIds' in scope) {
    scope.onUninstalled?.(stale)
  }
  for (const [id, generation] of removals) {
    if (stale.has(id)) {
      states.update(profileId, id, (state) => ({ ...state, removalGeneration: generation }))
    }
  }
  states.flush()
  return stale
}
