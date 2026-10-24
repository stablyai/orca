import { isNotificationTargetConsumed } from './consumed-notification-tray-dismissal'
import { wasPushDismissed } from './push-dismissal-watermarks'
import { dismissPresentedPushNotification } from './push-tray-dismissal'
import { shouldSuppressNotificationWhileViewing } from './notification-viewing-policy'
import { loadPushNotificationsEnabled } from '../storage/preferences'
import { loadHostCatalog } from '../transport/host-store'
import { resolveHostIdForFingerprint, resolveHostIdsForFingerprint } from './push-host-fingerprint'
import { readOrcaPushPayload, type OrcaPushPayload } from './push-payload'
import type { Notification, NotificationBehavior } from 'expo-notifications'
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

export async function foregroundNotificationBehavior(
  notification: Pick<Notification, 'request'>
): Promise<NotificationBehavior> {
  const rawTitle = (notification.request as { readonly content?: { readonly title?: unknown } })
    ?.content?.title
  const isTerminalBellTitle =
    typeof rawTitle === 'string' && rawTitle.trim().startsWith('Bell in ')
  const data = readNativeNotificationData(notification.request)
  const payload = readOrcaPushPayload(data)
  const explicitHostId =
    typeof (data as { readonly hostId?: unknown })?.hostId === 'string' &&
    (data as { readonly hostId: string }).hostId.length > 0
      ? (data as { readonly hostId: string }).hostId
      : undefined
  const preferences = await loadNotificationDeliveryPreferences()
  const reqIdentifier = (notification.request as { readonly identifier?: unknown })?.identifier
  const alreadyConsumed = isNotificationTargetConsumed({
    osNotificationIdentifier: typeof reqIdentifier === 'string' ? reqIdentifier : undefined,
    notificationId: payload?.notificationId
  })
  // Unrecognized notifications retain normal behavior; recognized pushes fail closed
  // when consent, host, viewing, or dismissal checks cannot complete.
  const ineligible = await shouldSuppressForegroundPush(
    payload,
    preferences.suppressWhileViewing,
    explicitHostId
  ).catch(() => payload !== null)
  const suppressed =
    isTerminalBellTitle ||
    alreadyConsumed ||
    ineligible ||
    (payload !== null && !claimForegroundPush(payload))
  return {
    shouldShowBanner: !suppressed,
    shouldShowList: !suppressed,
    shouldPlaySound: !suppressed && preferences.sound,
    shouldSetBadge: false
  }
}

export async function canPresentForegroundPush(
  payload: OrcaPushPayload,
  explicitHostId?: string
): Promise<boolean> {
  const preferences = await loadNotificationDeliveryPreferences()
  return !(await shouldSuppressForegroundPush(
    payload,
    preferences.suppressWhileViewing,
    explicitHostId
  ))
}

async function resolvePushHostIds(
  payload: OrcaPushPayload,
  explicitHostId?: string
): Promise<string[]> {
  const hosts = await loadHostCatalog().catch(() => [])
  const matched = resolveHostIdsForFingerprint(payload.hostFingerprint, hosts)
  if (explicitHostId && hosts.some((host) => host.id === explicitHostId)) {
    return matched.includes(explicitHostId) ? matched : [explicitHostId, ...matched]
  }
  return matched
}

async function shouldSuppressForegroundPush(
  payload: OrcaPushPayload | null,
  suppressWhileViewing: boolean,
  explicitHostId?: string
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
  const hostIds = await resolvePushHostIds(payload, explicitHostId)
  // Why suppressed rather than shown: the only pushes that outlive their host are
  // ones a gateway registration still holds after a removal whose unregister never
  // reached the desktop. A banner naming a host this phone no longer has cannot be
  // tapped anywhere, so it is noise the user cannot act on or turn off per-host.
  if (hostIds.length === 0) {
    return true
  }
  if (!(await loadPushNotificationsEnabled())) {
    return true
  }
  if (
    hostIds.some((hostId) =>
      shouldSuppressNotificationWhileViewing(payload, hostId, suppressWhileViewing)
    )
  ) {
    return true
  }
  // Keep this last: a socket/native dismissal may land during any preference or host read.
  return wasPushDismissed(payload)
}

/** Whether the OS says a notification came from a provider rather than this app. */
export function isRemotePushTrigger(trigger: unknown): boolean {
  return (
    typeof trigger === 'object' &&
    trigger !== null &&
    (trigger as { readonly type?: unknown }).type === 'push'
  )
}

/**
 * Notification data a tap can route with: the gateway names the host by fingerprint,
 * so it is mapped back to this device's hostId. Locally scheduled data passes
 * through untouched, which is what keeps its taps on their existing path.
 *
 * Why null and not the raw data when the fingerprint does not resolve: a gateway
 * payload is attacker-adjacent input, and passing it on would let a stray `hostId`
 * beside the `orca` block route a tap at a host the push never named. A remote
 * push with no fingerprint at all is the same input minus the block, so it is
 * unrouted too rather than handed to the local path as if this app scheduled it.
 */
export function pushNotificationRouteData(
  data: unknown,
  hosts: readonly { readonly id: string; readonly publicKeyB64: string }[],
  remote = false
): unknown {
  const payload = readOrcaPushPayload(data)
  if (!payload) {
    return remote ? null : data
  }
  const matchedHostIds = resolveHostIdsForFingerprint(payload.hostFingerprint, hosts)
  const explicitHostId =
    !remote &&
    typeof (data as { readonly hostId?: unknown })?.hostId === 'string' &&
    matchedHostIds.includes((data as { readonly hostId: string }).hostId)
      ? (data as { readonly hostId: string }).hostId
      : null
  const hostId = explicitHostId ?? matchedHostIds[0] ?? resolveHostIdForFingerprint(payload.hostFingerprint, hosts)
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
