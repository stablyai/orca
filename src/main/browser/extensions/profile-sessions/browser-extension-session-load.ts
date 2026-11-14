import { activateBrowserExtensionWorker } from '../api-runtime/browser-extension-worker-activation'
import {
  beginBrowserExtensionExecution,
  isBrowserExtensionExecutionLive,
  retireBrowserExtensionExecution,
  trackBrowserExtensionExecutionOperation
} from '../api-runtime/browser-extension-execution-authority'
import {
  initializeBrowserExtensionSessionAccess,
  reconcileBrowserExtensionSessionAccess
} from '../profile-storage/browser-extension-session-access'
import type { InstalledBrowserExtension } from '../../../../shared/browser/extensions/browser-extension-types'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import { getBrowserExtensionProfileStateStore } from '../profile-storage/browser-extension-profile-state-store'
import {
  fireRuntimeLifecycleEvents,
  type BrowserExtensionLoadKind
} from './browser-extension-runtime-lifecycle'
import {
  noteBrowserExtensionStorageOpened,
  removeReinstalledBrowserExtensionData,
  throwIfBrowserExtensionStorageAwaitingRestart
} from '../profile-storage/browser-extension-data-removal'
import {
  clearBrowserExtensionLoadFailure,
  recordBrowserExtensionLoadFailure
} from './browser-extension-load-errors'
import {
  prepareBrowserExtensionDirectory,
  type BrowserExtensionLoadSource
} from '../installation/browser-extension-load-directory'
import {
  throwIfBrowserExtensionLoadCancelled,
  type BrowserExtensionProfileLoad
} from './browser-extension-profile-loads'
import {
  refreshWorkerRegistration,
  removeBrowserExtensionFromSession
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
  const generation = store.removalGeneration(extension.id)
  if (
    (getBrowserExtensionProfileStateStore().read(profileId, extension.id).removalGeneration ??
      0) !== generation
  ) {
    await removeReinstalledBrowserExtensionData(sess, profileId, extension.id)
  }
  throwIfBrowserExtensionLoadCancelled(load)
  await initializeBrowserExtensionSessionAccess(sess)
  throwIfBrowserExtensionLoadCancelled(load)
  const execution = beginBrowserExtensionExecution(sess, extension.id, load.signal)
  try {
    return await trackBrowserExtensionExecutionOperation(execution, async () => {
      const prepared = await prepareBrowserExtensionDirectory(extension, execution, options)
      throwIfBrowserExtensionLoadCancelled(load)
      if (prepared.extensionId !== extension.id) {
        throw new Error('Extension id changed since it was added; remove it and add it again')
      }
      throwIfBrowserExtensionStorageAwaitingRestart(sess, prepared.extensionId)
      await refreshWorkerRegistration(sess, profileId, prepared)
      throwIfBrowserExtensionLoadCancelled(load)
      const result = await sess.extensions.loadExtension(prepared.directory, {
        allowFileAccess: false
      })
      if (!isBrowserExtensionExecutionLive(execution) || result.id !== prepared.extensionId) {
        // The profile load queue still owns this native result; no successor has started.
        removeBrowserExtensionFromSession(sess, result.id, 'suspend')
        throwIfBrowserExtensionLoadCancelled(load)
        throw new Error('Extension id changed since it was added; remove it and add it again')
      }
      noteBrowserExtensionStorageOpened(sess, result.id)
      if (prepared.hasWorker) {
        await activateBrowserExtensionWorker(execution)
      }
      throwIfBrowserExtensionLoadCancelled(load)
      await reconcileBrowserExtensionSessionAccess(sess, result.id, execution.controller.signal)
      throwIfBrowserExtensionLoadCancelled(load)
      fireRuntimeLifecycleEvents(sess, profileId, result, kind)
      return result
    })
  } catch (error) {
    // Revocation precedes removal; native work admitted by this load has already settled.
    const retired = retireBrowserExtensionExecution(sess, extension.id)
    if (sess.extensions.getExtension(extension.id)) {
      removeBrowserExtensionFromSession(sess, extension.id, 'suspend')
    }
    await (execution.retired ?? retired)
    throw error
  }
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
