import { measureUtf8ByteLength } from '../../../src/shared/utf8-byte-limits'

export const MOBILE_NOTIFICATION_EVENT_MAX_BYTES = 256 * 1024
export const MOBILE_NOTIFICATION_ACTIVE_MAX_BYTES = 4 * 1024 * 1024
export const MOBILE_NOTIFICATION_ACTIVE_MAX_ENTRIES = 256
export const MOBILE_NOTIFICATION_HOST_ID_MAX_BYTES = 8 * 1024
export const MOBILE_NOTIFICATION_ID_MAX_BYTES = 8 * 1024
export const MOBILE_NOTIFICATION_WORKTREE_ID_MAX_BYTES = 16 * 1024

type MobileNotificationRetentionEvent = {
  type: string
  source?: string
  title?: string
  body?: string
  worktreeId?: string
  notificationId?: string
}

function boundedStringBytes(value: unknown, maxBytes: number): number | null {
  if (value === undefined) {
    return 0
  }
  if (typeof value !== 'string') {
    return null
  }
  const measured = measureUtf8ByteLength(value, { stopAfterBytes: maxBytes })
  return measured.exceededLimit ? null : measured.byteLength
}

export function isMobileNotificationHostIdRetainable(hostId: string): boolean {
  return boundedStringBytes(hostId, MOBILE_NOTIFICATION_HOST_ID_MAX_BYTES) !== null
}

export function measureMobileNotificationDeliveryBytes(
  event: MobileNotificationRetentionEvent,
  hostId: string
): number | null {
  const hostBytes = boundedStringBytes(hostId, MOBILE_NOTIFICATION_HOST_ID_MAX_BYTES)
  const notificationIdBytes = boundedStringBytes(
    event.notificationId,
    MOBILE_NOTIFICATION_ID_MAX_BYTES
  )
  const worktreeIdBytes = boundedStringBytes(
    event.worktreeId,
    MOBILE_NOTIFICATION_WORKTREE_ID_MAX_BYTES
  )
  if (hostBytes === null || notificationIdBytes === null || worktreeIdBytes === null) {
    return null
  }

  let retainedBytes = 256 + hostBytes + notificationIdBytes + worktreeIdBytes
  for (const value of [event.type, event.source, event.title, event.body]) {
    const remaining = MOBILE_NOTIFICATION_EVENT_MAX_BYTES - retainedBytes
    const valueBytes = boundedStringBytes(value, remaining)
    if (valueBytes === null) {
      return null
    }
    retainedBytes += valueBytes
  }
  return retainedBytes <= MOBILE_NOTIFICATION_EVENT_MAX_BYTES ? retainedBytes : null
}

export class MobileNotificationDeliveryLedger {
  private activeEntries = 0
  private activeBytes = 0
  private maxEntries = MOBILE_NOTIFICATION_ACTIVE_MAX_ENTRIES

  claim(event: MobileNotificationRetentionEvent, hostId: string): (() => void) | null {
    const retainedBytes = measureMobileNotificationDeliveryBytes(event, hostId)
    if (
      retainedBytes === null ||
      this.activeEntries >= this.maxEntries ||
      this.activeBytes + retainedBytes > MOBILE_NOTIFICATION_ACTIVE_MAX_BYTES
    ) {
      return null
    }
    this.activeEntries += 1
    this.activeBytes += retainedBytes
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      this.activeEntries = Math.max(0, this.activeEntries - 1)
      this.activeBytes = Math.max(0, this.activeBytes - retainedBytes)
    }
  }

  resetForTests(maxEntries?: number): void {
    this.activeEntries = 0
    this.activeBytes = 0
    this.maxEntries = maxEntries ?? MOBILE_NOTIFICATION_ACTIVE_MAX_ENTRIES
  }
}
