import { wasPushDismissed } from './push-dismissal-watermarks'
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import { shouldSuppressNotificationWhileViewing } from './notification-viewing-policy'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { loadHostCatalog } from '../transport/host-store'
import { resolveHostIdForFingerprint } from './push-host-fingerprint'
import { readOrcaPushPayload, type OrcaPushPayload } from './push-payload'
import type { NotificationBehavior } from 'expo-notifications'
import { readNativeNotificationData } from './native-notification-data'
import { loadNotificationDeliveryPreferences } from './notification-delivery-preferences'

const RECENT_FOREGROUND_PUSH_CAP = 512
const recentForegroundPushes = new Set<string>()

function claimForegroundPush(payload: OrcaPushPayload): boolean {
  const seq = payload.notificationSeq
  if (
    !payload.notificationEpoch ||
    typeof seq !== 'number' ||
    !Number.isSafeInteger(seq) ||
    seq < 0
  ) {
    return true
  }
  const key = JSON.stringify([
    payload.hostFingerprint,
    payload.notificationEpoch,
    payload.notificationId ?? null,
    seq
  ])
  if (recentForegroundPushes.has(key)) {
    return false
  }
  recentForegroundPushes.add(key)
  if (recentForegroundPushes.size > RECENT_FOREGROUND_PUSH_CAP) {
    const oldest = recentForegroundPushes.values().next().value
    if (oldest !== undefined) {
      recentForegroundPushes.delete(oldest)
    }
  }
  return true
}

export function resetForegroundPushClaimsForTests(): void {
  recentForegroundPushes.clear()
}

export async function foregroundNotificationBehavior(notification: {
  request: Parameters<typeof readNativeNotificationData>[0]
}): Promise<NotificationBehavior> {
  const data = readNativeNotificationData(notification.request)
  const payload = readOrcaPushPayload(data)
  const preferences = await loadNotificationDeliveryPreferences()
  // Preserve unknown notifications; recognized pushes fail closed when eligibility/dismissal checks cannot complete.
  const ineligible = await shouldSuppressForegroundPush(
    payload,
    preferences.suppressWhileViewing
  ).catch(() => payload !== null)
  const suppressed = ineligible || (payload !== null && !claimForegroundPush(payload))
  return {
    shouldShowBanner: !suppressed,
    shouldShowList: !suppressed,
    shouldPlaySound: !suppressed && preferences.sound,
    shouldSetBadge: false
  }
}

export async function canPresentForegroundPush(payload: OrcaPushPayload): Promise<boolean> {
  const preferences = await loadNotificationDeliveryPreferences()
  return !(await shouldSuppressForegroundPush(payload, preferences.suppressWhileViewing))
}

async function resolvePushHostId(payload: OrcaPushPayload): Promise<string | null> {
  const hosts = await loadHostCatalog().catch(() => [])
  return resolveHostIdForFingerprint(payload.hostFingerprint, hosts)
}

async function shouldSuppressForegroundPush(
  payload: OrcaPushPayload | null,
  suppressWhileViewing: boolean
): Promise<boolean> {
  if (!payload) {
    return false
  }
  if (payload.kind === 'dismiss') {
    if (payload.notificationId) {
      await dismissPresentedPushNotification(
        payload.notificationId,
        payload.hostFingerprint,
        payload
      )
    }
    return true
  }
  const hostId = await resolvePushHostId(payload)
  // Suppress removed-host pushes: stale gateway registrations cannot route a useful tap and the phone can no longer disable them per host.
  if (!hostId) {
    return true
  }
  if (!(await loadPushNotificationsEnabled())) {
    return true
  }
  if (shouldSuppressNotificationWhileViewing(payload, hostId, suppressWhileViewing)) {
    return true
  }
  // Keep this last: a socket/native dismissal may land during any preference or host read.
  return wasPushDismissed(payload)
}

export function isRemotePushTrigger(trigger: unknown): boolean {
  return (
    typeof trigger === 'object' &&
    trigger !== null &&
    (trigger as { readonly type?: unknown }).type === 'push'
  )
}

// Resolve gateway fingerprints to this device’s host id; preserve locally scheduled data.
// Unresolved/missing remote fingerprints must not fall back to raw hostId fields that the provider never authenticated as this push’s host.
export function pushNotificationRouteData(
  data: unknown,
  hosts: readonly { readonly id: string; readonly publicKeyB64: string }[],
  remote = false
): unknown {
  const payload = readOrcaPushPayload(data)
  if (!payload) {
    return remote ? null : data
  }
  const hostId = resolveHostIdForFingerprint(payload.hostFingerprint, hosts)
  if (!hostId) {
    return null
  }
  return {
    hostId,
    ...(payload.paneKey ? { paneKey: payload.paneKey } : {}),
    ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
    ...(payload.executionHost ? { executionHost: payload.executionHost } : {})
  }
}
