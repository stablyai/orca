import { runBrowserExtensionNativePage } from '../api-runtime/browser-extension-native-page'
import { extensionHasPermission } from '../api-runtime/browser-extension-namespace-registry'

// Why below the content-script restore's 2.5s: both run in the same reattach budget.
const SNAPSHOT_TIMEOUT_MS = 2_000

/** Extensions that wrote chrome.storage.session since they loaded; others have nothing to keep. */
const writtenBySession = new WeakMap<Electron.Session, Set<string>>()
/**
 * Profile → extension → chrome.storage.session items an idle unload took. Memory only: it can
 * hold credentials, and Chromium clears the area on every extension unload and browser restart.
 */
const snapshots = new Map<string, Map<string, Record<string, unknown>>>()

export function noteBrowserExtensionSessionStorageWritten(
  sess: Electron.Session,
  extensionId: string
): void {
  const written = writtenBySession.get(sess) ?? new Set<string>()
  writtenBySession.set(sess, written.add(extensionId))
}

/** Unloading clears the native area, so nothing is written until the extension writes again. */
export function forgetBrowserExtensionSessionStorageWritten(
  sess: Electron.Session,
  extensionId: string
): void {
  writtenBySession.get(sess)?.delete(extensionId)
}

export function forgetBrowserExtensionSessionStorageSnapshot(
  profileId: string,
  extensionId: string
): void {
  const byExtension = snapshots.get(profileId)
  byExtension?.delete(extensionId)
  if (byExtension?.size === 0) {
    snapshots.delete(profileId)
  }
}

// Serialized into a native-only extension page; keep all its dependencies inside this function.
async function runNativeSessionStorage(items: Record<string, unknown> | null): Promise<unknown> {
  const root: { chrome?: { storage?: { session?: unknown } } } = globalThis
  const area = root.chrome?.storage?.session
  if (!area || typeof area !== 'object' || !('get' in area) || !('set' in area)) {
    throw new Error('Native session storage is unavailable')
  }
  const { get, set } = area
  if (typeof get !== 'function' || typeof set !== 'function') {
    throw new Error('Native session storage is unavailable')
  }
  return items ? set.call(area, items) : get.call(area, null)
}

function runOnNativePage(
  sess: Electron.Session,
  extensionId: string,
  items: Record<string, unknown> | null
): Promise<unknown> {
  return runBrowserExtensionNativePage({
    session: sess,
    extensionId,
    code: `(${runNativeSessionStorage.toString()})(${JSON.stringify(items)})`,
    timeoutMs: SNAPSHOT_TIMEOUT_MS
  })
}

/**
 * Before an idle unload removes the extension: keeps what it put in chrome.storage.session.
 * Resolves false when the area could not be read, so the reattach starts the extension clean.
 */
export async function snapshotBrowserExtensionSessionStorage(
  sess: Electron.Session,
  profileId: string,
  extension: Electron.Extension
): Promise<boolean> {
  forgetBrowserExtensionSessionStorageSnapshot(profileId, extension.id)
  if (
    !writtenBySession.get(sess)?.has(extension.id) ||
    !extensionHasPermission(extension, 'storage', sess)
  ) {
    return true
  }
  try {
    const items = await runOnNativePage(sess, extension.id, null)
    if (!items || typeof items !== 'object' || Array.isArray(items)) {
      return false
    }
    if (Object.keys(items).length > 0) {
      const byExtension = snapshots.get(profileId) ?? new Map<string, Record<string, unknown>>()
      snapshots.set(profileId, byExtension.set(extension.id, { ...items }))
    }
    return true
  } catch (error) {
    console.warn(`[browser-extensions] Could not keep session storage of ${extension.id}:`, error)
    return false
  }
}

/** After the reattach loads the extension: puts its kept session storage back. False on failure. */
export async function restoreBrowserExtensionSessionStorage(
  sess: Electron.Session,
  profileId: string,
  extension: Electron.Extension
): Promise<boolean> {
  const items = snapshots.get(profileId)?.get(extension.id)
  forgetBrowserExtensionSessionStorageSnapshot(profileId, extension.id)
  if (!items) {
    return true
  }
  try {
    await runOnNativePage(sess, extension.id, items)
    noteBrowserExtensionSessionStorageWritten(sess, extension.id)
    return true
  } catch (error) {
    console.warn(
      `[browser-extensions] Could not restore session storage of ${extension.id}:`,
      error
    )
    return false
  }
}
