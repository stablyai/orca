import {
  deleteHostPageCache,
  forgetHostUpdateFailures
} from '../mobile-web-shell/removed-host-shell-cache'
import { unregisterPushForRemovedHost } from '../notifications/push-registration'
import { forgetHostDescriptor } from './host-descriptor-store'
import { removeHost } from './host-store'

export async function removeHostAndCloseClient(
  hostId: string,
  forgetHostClient: (hostId: string) => void
): Promise<void> {
  // Unregister before removal while the client is authenticated; desktop revocation covers undelivered requests.
  const restorePushRegistration = await unregisterPushForRemovedHost(hostId)
  // Close only after metadata commits so storage failure cannot strand a still-paired host.
  try {
    await removeHost(hostId)
  } catch (error) {
    restorePushRegistration()
    throw error
  }
  forgetHostClient(hostId)
  forgetHostDescriptor(hostId)
  // After commit, cache cleanup must not delay/fail removal; the next launch sweep reclaims a failed delete.
  void forgetHostUpdateFailures(hostId).catch(() => undefined)
  void deleteHostPageCache(hostId).catch(() => undefined)
}
