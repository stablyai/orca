import { loadHostCatalog } from '../transport/host-store'
import {
  adoptNotificationEpoch,
  getHostNotificationSession,
  seedWatermarkFromStorage,
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
  // Why suppressed rather than shown: the only pushes that outlive their host are
  // ones a gateway registration still holds after a removal whose unregister never
  // reached the desktop. A banner naming a host this phone no longer has cannot be
  // tapped anywhere, so it is noise the user cannot act on or turn off per-host.
  if (!hostId) {
    return true
  }
  const session = getHostNotificationSession(hostId)
  // Why seeded first: the socket may never have connected this launch (phone on
  // cellular), leaving lastDeliveredEpoch null. Adopting against an unseeded session
  // resets the seq to 0 and persists that over a valid watermark, so the next
  // reconnect replays the desktop's whole retained buffer.
  seedWatermarkFromStorage(session, hostId)
  await session.watermarkSeeded
  // A push that names no counter lifetime cannot claim a seq-derived key: the
  // desktop always sends the epoch, so this is shown as-is and never marked.
  if (payload.notificationEpoch == null) {
    return false
  }
  // The seen keys are seq-derived, so a push from a new desktop lifetime must void
  // them before its own key is tested against a counter that no longer exists.
  adoptNotificationEpoch(session, hostId, payload.notificationEpoch)
  // Why a coalesced summary is neither suppressed nor marked: it carries only the
  // latest event's fields, so claiming that key would make the socket swallow the
  // specific banner for an event the summary only ever counted.
  if ((payload.coalescedCount ?? 0) > 1) {
    return false
  }
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
  const hostId = resolveHostIdForFingerprint(payload.hostFingerprint, hosts)
  if (!hostId) {
    return null
  }
  return {
    hostId,
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.worktreeId ? { worktreeId: payload.worktreeId } : {}),
    ...(payload.notificationId ? { notificationId: payload.notificationId } : {})
  }
}
