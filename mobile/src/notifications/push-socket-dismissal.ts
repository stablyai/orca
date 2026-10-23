import { loadHostCatalog } from '../transport/host-store'
import { deriveHostFingerprint } from './push-host-fingerprint'
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import { dismissInAppNotificationBannerById } from './in-app-notification-banner-store'
import type { DismissNotificationEvent } from './desktop-notification-events'

async function hostFingerprint(hostId: string): Promise<string | null> {
  const hosts = await loadHostCatalog().catch(() => [])
  const host = hosts.find((item) => item.id === hostId)
  return host ? deriveHostFingerprint(host.publicKeyB64) : null
}

export async function dismissHostPushNotification(
  event: DismissNotificationEvent,
  hostId: string
): Promise<void> {
  const target = event.dismissedDelivery ?? event
  dismissInAppNotificationBannerById(target.notificationId, hostId)
  const fingerprint = await hostFingerprint(hostId)
  if (!fingerprint) {
    return
  }
  const fence =
    target.notificationEpoch && target.notificationSeq !== undefined ? target : undefined
  await dismissPresentedPushNotification(target.notificationId, fingerprint, fence)
}
