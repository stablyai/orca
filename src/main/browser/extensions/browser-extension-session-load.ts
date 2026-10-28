import type { InstalledBrowserExtension } from '../../../shared/browser-extension-types'
import { getBrowserExtensionInstallStore } from './browser-extension-install-store'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import {
  fireRuntimeLifecycleEvents,
  type BrowserExtensionLoadKind
} from './browser-extension-runtime-lifecycle'
import {
  noteBrowserExtensionStorageOpened,
  removeReinstalledBrowserExtensionData,
  throwIfBrowserExtensionStorageAwaitingRestart
} from './browser-extension-data-removal'
import {
  clearBrowserExtensionLoadFailure,
  recordBrowserExtensionLoadFailure
} from './browser-extension-load-errors'
import {
  prepareBrowserExtensionDirectory,
  type BrowserExtensionLoadSource
} from './browser-extension-load-directory'
import {
  throwIfBrowserExtensionLoadCancelled,
  type BrowserExtensionProfileLoad
} from './browser-extension-profile-loads'
import {
  refreshWorkerRegistration,
  removeBrowserExtensionFromSession,
  whenWorkerRegistered
} from './browser-extension-worker-registration'

export async function loadBrowserExtensionIntoSession(
  sess: Electron.Session,
  profileId: string,
  extension: BrowserExtensionLoadSource & { id: string },
  kind: BrowserExtensionLoadKind,
  load: BrowserExtensionProfileLoad,
  options: { refresh?: boolean } = {}
): Promise<Electron.Extension> {
  throwIfBrowserExtensionLoadCancelled(load)
  const known = sess.extensions.getExtension(extension.id)
  if (known) {
    return known
  }
  const store = getBrowserExtensionInstallStore()
  const generation = store.removalGenerations().get(extension.id) ?? 0
  if (
    getBrowserExtensionProfileStateStore().read(profileId, extension.id).removalGeneration !==
    generation
  ) {
    await removeReinstalledBrowserExtensionData(sess, profileId, extension.id)
  }
  throwIfBrowserExtensionLoadCancelled(load)
  const prepared = await prepareBrowserExtensionDirectory(extension, options)
  throwIfBrowserExtensionLoadCancelled(load)
  if (prepared.extensionId !== extension.id) {
    // Why: an unpacked folder whose id changed (e.g. a new manifest key) is a different extension.
    throw new Error('Extension id changed since it was added; remove it and add it again')
  }
  throwIfBrowserExtensionStorageAwaitingRestart(sess, prepared.extensionId)
  const reregisters = await refreshWorkerRegistration(sess, profileId, prepared)
  throwIfBrowserExtensionLoadCancelled(load)
  const registered =
    reregisters && prepared.hasWorker ? whenWorkerRegistered(sess, prepared.extensionId) : null
  const result = await sess.extensions.loadExtension(prepared.directory, {
    allowFileAccess: false
  })
  noteBrowserExtensionStorageOpened(sess, result.id)
  if (result.id !== prepared.extensionId) {
    removeBrowserExtensionFromSession(sess, result.id)
    throw new Error('Extension id changed since it was added; remove it and add it again')
  }
  await registered
  if (load.cancelled && sess.extensions.getExtension(result.id)) {
    removeBrowserExtensionFromSession(sess, result.id)
  }
  throwIfBrowserExtensionLoadCancelled(load)
  fireRuntimeLifecycleEvents(sess, profileId, result, kind)
  return result
}

/** Loads an installed extension and keeps its last failure for Settings until a load succeeds. */
export async function loadInstalledBrowserExtensionIntoSession(
  sess: Electron.Session,
  profileId: string,
  extension: InstalledBrowserExtension,
  kind: BrowserExtensionLoadKind,
  load: BrowserExtensionProfileLoad
): Promise<Electron.Extension> {
  try {
    const loaded = await loadBrowserExtensionIntoSession(sess, profileId, extension, kind, load)
    clearBrowserExtensionLoadFailure(profileId, extension.id)
    return loaded
  } catch (error) {
    recordBrowserExtensionLoadFailure(profileId, extension.id, error)
    throw error
  }
}
