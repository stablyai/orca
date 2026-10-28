import { getChromeExtensionOrigin } from '../../../shared/browser-extension-url'
import { getBrowserExtensionProfileStateStore } from './browser-extension-profile-state-store'
import type { PreparedBrowserExtensionDirectory } from './browser-extension-load-directory'

// Why: removing an extension makes Chromium unregister its worker, so its next load registers anew.
const unregisteredWorkersBySession = new WeakMap<Electron.Session, Set<string>>()

export function removeBrowserExtensionFromSession(
  sess: Electron.Session,
  extensionId: string
): void {
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
  if (workerSignature && states.read(profileId, extensionId).workerSignature === workerSignature) {
    return unregistered
  }
  await sess.clearStorageData({
    origin: getChromeExtensionOrigin(extensionId),
    storages: ['serviceworkers']
  })
  if (workerSignature) {
    states.update(profileId, extensionId, (state) => ({
      ...state,
      workerSignature
    }))
  }
  return true
}

const WORKER_REGISTRATION_WAIT_MS = 10_000

/**
 * loadExtension resolves before Chromium has registered the worker, and until it has, every start
 * fails ("Failed to start service worker."). The load waits so Orca's lifecycle events and
 * restored tabs start a worker that exists. Listen before loading: registration can finish first.
 */
export function whenWorkerRegistered(sess: Electron.Session, extensionId: string): Promise<void> {
  const scope = `${getChromeExtensionOrigin(extensionId)}/`
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      sess.serviceWorkers.removeListener('registration-completed', onRegistered)
      resolve()
    }
    const onRegistered = (_event: Electron.Event, details: { scope: string }): void => {
      if (details.scope === scope) {
        done()
      }
    }
    const timer = setTimeout(done, WORKER_REGISTRATION_WAIT_MS)
    sess.serviceWorkers.on('registration-completed', onRegistered)
  })
}
