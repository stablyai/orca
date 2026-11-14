import { getChromeExtensionOrigin } from '../../../../shared/browser/extensions/browser-extension-url'
import { getBrowserExtensionProfileStateStore } from '../profile-storage/browser-extension-profile-state-store'
import type { PreparedBrowserExtensionDirectory } from '../installation/browser-extension-load-directory'
import { retireBrowserExtensionExecution } from '../api-runtime/browser-extension-execution-authority'

const cleanedNoWorker = new WeakMap<Electron.Session, Set<string>>()
const suspensions = new WeakMap<Electron.Session, Set<string>>()

export function isBrowserExtensionSuspension(
  sess: Electron.Session,
  extension: Electron.Extension
): boolean {
  return suspensions.get(sess)?.has(extension.path) ?? false
}

// Why: removing an extension makes Chromium unregister its worker, so its next load registers anew.
const unregisteredWorkersBySession = new WeakMap<Electron.Session, Set<string>>()

export function removeBrowserExtensionFromSession(
  sess: Electron.Session,
  extensionId: string,
  reason: 'suspend' | 'reset' = 'reset'
): void {
  const extension = sess.extensions.getExtension(extensionId)
  if (reason === 'suspend' && extension) {
    let paths = suspensions.get(sess)
    if (!paths) {
      paths = new Set()
      suspensions.set(sess, paths)
      sess.extensions.on('extension-unloaded', (_event, unloaded) => {
        queueMicrotask(() => paths?.delete(unloaded.path))
      })
    }
    paths.add(extension.path)
  }
  void retireBrowserExtensionExecution(sess, extensionId)
  sess.extensions.removeExtension(extensionId)
  const ids = unregisteredWorkersBySession.get(sess) ?? new Set<string>()
  ids.add(extensionId)
  unregisteredWorkersBySession.set(sess, ids)
}

/**
 * Chromium keeps running a worker's cached scripts until the extension version changes, so a new
 * wrapper or shim would never run. Dropping the registration makes the load register it afresh.
 * Returns whether the load will register the worker.
 */
export async function refreshWorkerRegistration(
  sess: Electron.Session,
  profileId: string,
  prepared: PreparedBrowserExtensionDirectory
): Promise<boolean> {
  const { extensionId, workerSignature } = prepared
  const states = getBrowserExtensionProfileStateStore()
  const unregistered = unregisteredWorkersBySession.get(sess)?.delete(extensionId) ?? false
  const noWorkers = cleanedNoWorker.get(sess) ?? new Set<string>()
  cleanedNoWorker.set(sess, noWorkers)
  if (!prepared.hasWorker && noWorkers.has(extensionId)) {
    return unregistered
  }
  if (prepared.hasWorker) {
    noWorkers.delete(extensionId)
  }
  if (workerSignature && states.read(profileId, extensionId).workerSignature === workerSignature) {
    return unregistered
  }
  await sess.clearStorageData({
    origin: getChromeExtensionOrigin(extensionId),
    storages: ['serviceworkers']
  })
  if (!prepared.hasWorker) {
    noWorkers.add(extensionId)
  }
  if (workerSignature) {
    states.update(profileId, extensionId, (state) => ({
      ...state,
      workerSignature
    }))
  }
  return true
}
