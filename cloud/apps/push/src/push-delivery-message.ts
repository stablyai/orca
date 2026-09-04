import { PUSH_LIMITS, type PushNotification } from '@orca-cloud/push-contract'

export type PushOrcaData = {
  hostFingerprint: string
  worktreeId?: string
  notificationId?: string
  notificationSeq: number
  notificationEpoch: string
  source: string
  agentState: string | null
  coalescedCount: number
}

export type PushDelivery = {
  registrationId: string
  hostFingerprint: string
  title: string
  body: string
  collapseId: string
  orca: PushOrcaData
}

export function hostCollapseId(hostFingerprint: string): string {
  return `host:${hostFingerprint}`
}

// APNs rejects a collapse id over 64 bytes, and notification ids are opaque
// desktop strings that may be longer or carry multi-byte characters.
export function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8')
  if (encoded.byteLength <= maxBytes) return value
  let end = maxBytes
  // Walk back off a continuation byte so the cut never splits a code point.
  while (end > 0 && (encoded[end]! & 0b1100_0000) === 0b1000_0000) end -= 1
  return encoded.subarray(0, end).toString('utf8')
}

export function collapseIdFor(
  notification: PushNotification,
  hostFingerprint: string,
  coalescedCount: number
): string {
  if (coalescedCount > 1 || notification.notificationId === undefined) {
    return hostCollapseId(hostFingerprint)
  }
  return truncateUtf8(notification.notificationId, PUSH_LIMITS.apnsCollapseIdMaxBytes)
}

export function buildPushDelivery(input: {
  registrationId: string
  hostFingerprint: string
  notification: PushNotification
  title: string
  body: string
  coalescedCount: number
}): PushDelivery {
  const { notification, hostFingerprint, coalescedCount } = input
  return {
    registrationId: input.registrationId,
    hostFingerprint,
    title: input.title,
    body: input.body,
    collapseId: collapseIdFor(notification, hostFingerprint, coalescedCount),
    orca: {
      hostFingerprint,
      ...(notification.worktreeId === undefined ? {} : { worktreeId: notification.worktreeId }),
      ...(notification.notificationId === undefined
        ? {}
        : { notificationId: notification.notificationId }),
      notificationSeq: notification.notificationSeq,
      notificationEpoch: notification.notificationEpoch,
      source: notification.source,
      agentState: notification.agentState,
      coalescedCount
    }
  }
}

export function orcaDataStrings(orca: PushOrcaData): Record<string, string> {
  return Object.fromEntries(
    Object.entries(orca)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value)])
  )
}
