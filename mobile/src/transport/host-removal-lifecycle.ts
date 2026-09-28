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
  // Why before removeHost: the unregister needs the still-authenticated client, and
  // the desktop's own revoke path covers the case where this call cannot land.
  const restorePushRegistration = await unregisterPushForRemovedHost(hostId)
  // Why: closing before the metadata commit can strand a still-paired host on
  // storage failure; closing immediately after success prevents socket leaks.
  try {
    await removeHost(hostId)
  } catch (error) {
    restorePushRegistration()
    throw error
  }
  forgetHostClient(hostId)
  forgetHostDescriptor(hostId)
  // Why after the commit and not awaited: state about a host that is gone, never a reason to hold
  // the removal or fail it. A cache that fails to delete is reclaimed by the next eviction.
  void forgetHostUpdateFailures(hostId).catch(() => undefined)
  void deleteHostPageCache(hostId).catch(() => undefined)
}
