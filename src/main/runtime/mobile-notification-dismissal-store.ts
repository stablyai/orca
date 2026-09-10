import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFile, hardenExistingSecureFile } from '../../shared/secure-file'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'

export type DeliveredNotificationIdentity = {
  notificationId: string
  notificationEpoch: string
  notificationSeq: number
}
type RecordEntry = DeliveredNotificationIdentity & { dismissedThrough: number; expiresAt: number }
const LIMIT = 4096
const RETENTION_MS = 7 * 86400_000

export class MobileNotificationDismissalStore {
  private readonly path: string
  private entries: RecordEntry[] = []
  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'mobile-notification-dismissals.json')
    if (!existsSync(this.path)) {
      return
    }
    try {
      hardenExistingSecureFile(this.path)
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (Array.isArray(value)) {
        this.entries = value.filter(isEntry).slice(-LIMIT)
      }
    } catch {
      // Missing history cannot establish that a delivered alert was dismissed.
    }
  }

  record(
    event: MobileNotificationEvent & { notificationEpoch: string; notificationSeq: number }
  ): void {
    if (!event.notificationId) {
      return
    }
    const now = Date.now()
    const kept = this.entries.filter((entry) => entry.expiresAt > now)
    const same = (entry: RecordEntry) =>
      entry.notificationId === event.notificationId &&
      entry.notificationEpoch === event.notificationEpoch
    let next: RecordEntry[]
    if (event.type === 'notification') {
      next = [
        ...kept.filter((entry) => !same(entry)),
        {
          notificationId: event.notificationId,
          notificationEpoch: event.notificationEpoch,
          notificationSeq: event.notificationSeq,
          dismissedThrough: kept.find(same)?.dismissedThrough ?? -1,
          expiresAt: now + RETENTION_MS
        }
      ]
    } else {
      next = kept
        .filter((entry) => !same(entry))
        .map((entry) =>
          entry.notificationId === event.notificationId
            ? { ...entry, dismissedThrough: entry.notificationSeq, expiresAt: now + RETENTION_MS }
            : entry
        )
      next.push({
        notificationId: event.notificationId,
        notificationEpoch: event.notificationEpoch,
        notificationSeq: event.notificationSeq,
        dismissedThrough: event.notificationSeq,
        expiresAt: now + RETENTION_MS
      })
    }
    next = next.slice(-LIMIT)
    writeSecureJsonFile(this.path, next)
    this.entries = next
  }

  reconcile(delivered: readonly DeliveredNotificationIdentity[]): DeliveredNotificationIdentity[] {
    const now = Date.now()
    return delivered.filter((item) =>
      this.entries.some(
        (entry) =>
          entry.dismissedThrough >= 0 &&
          entry.expiresAt > now &&
          entry.notificationId === item.notificationId &&
          entry.notificationEpoch === item.notificationEpoch &&
          entry.dismissedThrough >= item.notificationSeq
      )
    )
  }
}

function isEntry(value: unknown): value is RecordEntry {
  if (!value || typeof value !== 'object') {
    return false
  }
  const item = value as RecordEntry
  return (
    typeof item.notificationId === 'string' &&
    item.notificationId.length > 0 &&
    typeof item.notificationEpoch === 'string' &&
    item.notificationEpoch.length > 0 &&
    Number.isSafeInteger(item.notificationSeq) &&
    item.notificationSeq >= 0 &&
    Number.isSafeInteger(item.dismissedThrough) &&
    item.dismissedThrough >= -1 &&
    Number.isFinite(item.expiresAt)
  )
}
