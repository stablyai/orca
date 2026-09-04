import { loadHostCatalog } from '../transport/host-store'
import {
  adoptNotificationEpoch,
  getHostNotificationSession,
  seenKeyForEvent
} from './notification-reconnect-catchup'
import { resolveHostIdForFingerprint } from './push-host-fingerprint'
import { readOrcaPushPayload, type OrcaPushPayload } from './push-payload'

async function resolvePushHostId(payload: OrcaPushPayload): Promise<string | null> {
  const hosts = await loadHostCatalog().catch(() => [])
  return resolveHostIdForFingerprint(payload.hostFingerprint, hosts)
}

/**
 * Whether a foreground notification is a push for an event the socket already
 * delivered, and must therefore be swallowed instead of banner'd a second time.
 *
 * Marking happens here rather than in a received listener because the handler is
 * the only hook that can actually suppress, and the key must be claimed exactly
 * once — a listener running afterwards would mark an event the handler dropped.
 */
export async function shouldSuppressForegroundPush(data: unknown): Promise<boolean> {
  const payload = readOrcaPushPayload(data)
  if (!payload) {
    return false
  }
  const hostId = await resolvePushHostId(payload)
  // An unresolvable fingerprint is still a real desktop alert; show it rather than
  // silently drop the one notification we cannot attribute.
  if (!hostId) {
    return false
  }
  const session = getHostNotificationSession(hostId)
  // The seen keys are seq-derived, so a push from a new desktop lifetime must void
  // them before its own key is tested against a counter that no longer exists.
  adoptNotificationEpoch(session, hostId, payload.notificationEpoch)
  const key = seenKeyForEvent(payload)
  if (!key) {
    return false
  }
  if (session.seen.has(key)) {
    return true
  }
  session.seen.add(key)
  return false
}

/**
 * Notification data a tap can route with: the gateway names the host by fingerprint,
 * so it is mapped back to this device's hostId. Anything else passes through
 * untouched, which is what keeps locally scheduled taps on their existing path.
 */
export function pushNotificationRouteData(
  data: unknown,
  hosts: readonly { readonly id: string; readonly publicKeyB64: string }[]
): unknown {
  const payload = readOrcaPushPayload(data)
  if (!payload) {
    return data
  }
  const hostId = resolveHostIdForFingerprint(payload.hostFingerprint, hosts)
  if (!hostId) {
    return data
  }
  return {
    hostId,
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
    ...(payload.notificationId ? { notificationId: payload.notificationId } : {})
  }
}
