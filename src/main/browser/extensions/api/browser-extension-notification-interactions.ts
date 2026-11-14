import { browserSessionRegistry } from '../../sessions/profiles/browser-session-registry'
import { emitBrowserExtensionEvent } from '../api-runtime/browser-extension-api-host'
import { getHostSessionState } from '../api-runtime/browser-extension-contexts'
import {
  getBrowserExtensionExecution,
  isBrowserExtensionExecutionLive
} from '../api-runtime/browser-extension-execution-authority'
import { activateBrowserExtensionWorker } from '../api-runtime/browser-extension-worker-activation'
import { deliverBrowserExtensionWorkerInteraction } from '../api-runtime/browser-extension-worker-delivery'
import { extensionHasPermission } from '../api-runtime/browser-extension-namespace-registry'
import { getBrowserExtensionInstallStore } from '../installation/browser-extension-install-store'
import { withBrowserExtensionProfileOperation } from '../profile-sessions/browser-extension-profile-loading'
import { noteBrowserExtensionUserGesture } from '../permissions/browser-extension-user-gesture'

/** Notification closures retain only stable session/id; a real interaction resolves current authority. */
export async function dispatchBrowserExtensionNotificationInteraction(
  session: Electron.Session,
  extensionId: string,
  event: string,
  args: unknown[]
): Promise<void> {
  const profileId = browserSessionRegistry.profileIdForSession(session)
  if (
    !profileId ||
    !browserSessionRegistry.getEnabledExtensionIds(profileId).includes(extensionId) ||
    !getBrowserExtensionInstallStore().get(extensionId)
  ) {
    return
  }
  await withBrowserExtensionProfileOperation(profileId, extensionId, async (currentSession) => {
    if (
      currentSession !== session ||
      !browserSessionRegistry.getEnabledExtensionIds(profileId).includes(extensionId)
    ) {
      return
    }
    const extension = session.extensions.getExtension(extensionId)
    const execution = getBrowserExtensionExecution(session, extensionId)
    if (
      !extension ||
      !execution ||
      !isBrowserExtensionExecutionLive(execution) ||
      !extensionHasPermission(extension, 'notifications', session)
    ) {
      return
    }
    noteBrowserExtensionUserGesture(session, extensionId)
    const background: unknown = extension.manifest.background
    if (background && typeof background === 'object' && 'service_worker' in background) {
      await activateBrowserExtensionWorker(execution)
    }
    if (!isBrowserExtensionExecutionLive(execution)) {
      return
    }
    emitBrowserExtensionEvent(
      { session, extensionId, exceptCaller: { fromWorker: true } },
      'notifications',
      event,
      args
    )
    const context = getHostSessionState(session)?.workers.get(extensionId)
    if (context?.events.has(`notifications.${event}`)) {
      await deliverBrowserExtensionWorkerInteraction(execution, context, {
        namespace: 'notifications',
        event,
        args
      })
    }
  })
}
