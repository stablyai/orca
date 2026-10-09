// Why: the push gateway and Google FCM relay every field of a notification in the
// clear, and the rich body is the agent's last message or tool input (commands,
// paths, sometimes secrets). For a phone that opted in, each notification is sealed
// with a key only the desktop and that phone hold: the pairing device token, which
// never reaches the gateway. The gateway still sees a generic title, the agent
// state and the sequence fields it needs for delivery, quotas and dismissal.
//
// Wire format (mirrored in mobile/src/notifications/push-sealed-payload.ts):
//   key       = HMAC-SHA256(key = deviceToken, "orca-push-e2e-v1")
//   paneKey   = "e2e1:" + base64(nonce[24] || secretbox(JSON envelope, nonce, key))
//   envelope  = { t?: title, b?: body, w?: worktreeId, n?: notificationId, e: epoch }
//   opaque(x) = "e2e1." + base64url(HMAC-SHA256(key, label + x))[0..32]
//   notificationId on the wire    = opaque("id:" + notificationId)
//   notificationEpoch on the wire = opaque("epoch:" + notificationEpoch)
// The epoch is per device because the gateway keys an event on (host, kind, epoch,
// seq) and refuses a second send of that event whose content differs, which every
// other phone's ciphertext does. Both opaque values are stable per device, so a
// retry and a later dismissal still name the same event and alert.
// paneKey is the carrier because the desktop never sends one and the gateway
// passes it through verbatim with a 2048-char budget.
import { createHmac } from 'node:crypto'
import nacl from 'tweetnacl'
import type { PushSendNotification } from './push-gateway-client'

export const SEALED_PUSH_PREFIX = 'e2e1:'
const OPAQUE_PREFIX = 'e2e1.'
const KEY_LABEL = 'orca-push-e2e-v1'
// The gateway's paneKey limit.
const MAX_SEALED_LENGTH = 2048

export type SealedPushEnvelope = { t?: string; b?: string; w?: string; n?: string; e: string }

export function derivePushSealKey(deviceToken: string): Uint8Array {
  return new Uint8Array(createHmac('sha256', deviceToken).update(KEY_LABEL).digest())
}

function opaque(key: Uint8Array, value: string): string {
  const digest = createHmac('sha256', key).update(value).digest('base64url')
  return `${OPAQUE_PREFIX}${digest.slice(0, 32)}`
}

export function opaquePushNotificationId(key: Uint8Array, notificationId: string): string {
  return opaque(key, `id:${notificationId}`)
}

export function opaquePushNotificationEpoch(key: Uint8Array, notificationEpoch: string): string {
  return opaque(key, `epoch:${notificationEpoch}`)
}

function sealEnvelope(envelope: SealedPushEnvelope, key: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const box = nacl.secretbox(new TextEncoder().encode(JSON.stringify(envelope)), nonce, key)
  return SEALED_PUSH_PREFIX + Buffer.concat([nonce, box]).toString('base64')
}

// Escaped as \u0000, each char costs 6 JSON bytes: the most an 80-char clipped title can take.
const WORST_CASE_TITLE = '\u0000'.repeat(80)

/** Decided from the id and epoch alone, so an alert and its dismissal always agree. */
function carriesRealId(notificationId: string, epoch: string, key: Uint8Array): boolean {
  // b: '' is what the shrink loop leaves behind, so it counts too.
  const probe = { t: WORST_CASE_TITLE, b: '', n: notificationId, e: epoch }
  return sealEnvelope(probe, key).length <= MAX_SEALED_LENGTH
}

function placeholderTitle(notification: PushSendNotification): string {
  if (notification.agentState === 'needs-input') {
    return 'Agent needs input'
  }
  if (notification.agentState === 'finished') {
    return 'Agent finished'
  }
  return 'Orca'
}

export function sealPushNotification(
  notification: PushSendNotification,
  deviceToken: string
): PushSendNotification {
  const key = derivePushSealKey(deviceToken)
  const { worktreeId, notificationId, notificationEpoch, title, body, ...rest } = notification
  const isDismiss = notification.kind === 'dismiss'
  const envelope: SealedPushEnvelope = {
    ...(isDismiss ? {} : { t: title, b: body }),
    ...(worktreeId ? { w: worktreeId } : {}),
    ...(notificationId && carriesRealId(notificationId, notificationEpoch, key)
      ? { n: notificationId }
      : {}),
    e: notificationEpoch
  }
  let sealed = sealEnvelope(envelope, key)
  while (sealed.length > MAX_SEALED_LENGTH && envelope.b) {
    // By code point, so an emoji is never split; each pass strictly shortens the body.
    const chars = Array.from(envelope.b)
    const kept = Math.floor(chars.length * 0.75) - 1
    envelope.b = kept > 0 ? `${chars.slice(0, kept).join('')}…` : ''
    sealed = sealEnvelope(envelope, key)
  }
  if (sealed.length > MAX_SEALED_LENGTH) {
    delete envelope.w
    sealed = sealEnvelope(envelope, key)
  }
  return {
    ...rest,
    ...(notificationId ? { notificationId: opaquePushNotificationId(key, notificationId) } : {}),
    notificationEpoch: opaquePushNotificationEpoch(key, notificationEpoch),
    title: isDismiss ? title : placeholderTitle(notification),
    body: '',
    paneKey: sealed
  }
}
