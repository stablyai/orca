import * as Notifications from 'expo-notifications'
import { loadHostCatalog } from '../transport/host-store'
import { seenKeyForEvent, type HostNotificationSession } from './notification-reconnect-catchup'
import { resolveHostIdForFingerprint } from './push-host-fingerprint'
import { readOrcaPushPayload } from './push-payload'

/**
 * Dedup keys for the pushes the OS has already drawn for one host.
 *
 * Why this exists: a push shown while Orca was closed never ran through the
 * foreground handler, so nothing in this process claimed its key. The reconnect
 * catch-up then replays that same event and shows a second banner for it.
 *
 * Kept separate from push-tray-dismissal.ts, which must stay free of the host
 * store (and its native keychain deps) because it runs on the socket dismiss path.
 */
export type PresentedPushSeenKey = { readonly key: string; readonly epoch: string | undefined }

export async function readPresentedPushSeenKeys(
  hostId: string
): Promise<readonly PresentedPushSeenKey[]> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync()
    if (presented.length === 0) {
      return []
    }
    const hosts = await loadHostCatalog().catch(() => [])
    const keys: PresentedPushSeenKey[] = []
    for (const notification of presented) {
      const payload = readOrcaPushPayload(notification.request.content.data)
      // A coalesced summary stands in for N events while carrying only the latest
      // one's fields, so its key belongs to a banner the user has NOT seen.
      if (!payload || (payload.coalescedCount ?? 0) > 1) {
        continue
      }
      if (resolveHostIdForFingerprint(payload.hostFingerprint, hosts) !== hostId) {
        continue
      }
      const key = seenKeyForEvent(payload)
      if (key) {
        keys.push({ key, epoch: payload.notificationEpoch })
      }
    }
    return keys
  } catch {
    // Older native shells lack the tray query; the catch-up replays as it did before.
    return []
  }
}

/**
 * Claim the tray's keys on the session, skipping any from a dead counter lifetime.
 *
 * The watermark is deliberately untouched: a push seq proves one event was shown,
 * not that everything below it was, and advancing past a gap would make the desktop
 * cut the notifications in it forever.
 */
export function markPresentedPushesSeen(
  session: HostNotificationSession,
  keys: readonly PresentedPushSeenKey[]
): void {
  for (const { key, epoch } of keys) {
    if (
      epoch != null &&
      session.lastDeliveredEpoch != null &&
      epoch !== session.lastDeliveredEpoch
    ) {
      continue
    }
    session.seen.add(key)
  }
}
