import {
  clearWatermark,
  forgetHostNotificationSession
} from '../notifications/notification-reconnect-catchup'
import { removeHost } from './host-store'
import { connectionLogStore } from './persisted-connection-log-store'
import { removeMobileWebHostCache } from '../mobile-web/mobile-web-native-stager'
import { clearMobileWebColdResumeRouteForHost } from '../mobile-web/mobile-web-cold-resume-route'

export async function removeHostAndCloseClient(
  hostId: string,
  hostPublicKey: string,
  forgetHostClient: (hostId: string) => void
): Promise<void> {
  // Why: closing before the metadata commit can strand a still-paired host on
  // storage failure; closing immediately after success prevents socket leaks.
  await removeHost(hostId)
  try {
    forgetHostClient(hostId)
  } finally {
    // Why: host-scoped process state must not survive a completed unpair.
    forgetHostNotificationSession(hostId)
    void clearWatermark(hostId)
    connectionLogStore.delete(hostId)
    // Why last: the hybrid WebView serves its document out of this cache, so deleting it while one
    // is still mounted 403s every asset the page asks for next. Cache deletion is recoverable by
    // redownload, so a hybrid-only failure here must never block the unpair either — on a native
    // build the cache may not even exist, and an unresolvable key is the same recoverable miss.
    if (hostPublicKey) {
      await removeMobileWebHostCache(hostPublicKey).catch(() => null)
    }
    await clearMobileWebColdResumeRouteForHost(hostId).catch(() => null)
  }
}
