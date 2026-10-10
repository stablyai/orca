import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hardenExistingSecureFile, isUnreadableError } from '../../shared/secure-file'
import { writeSecureJsonFileAsync } from '../../shared/secure-file-async-write'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import type { DeliveredNotificationIdentity } from '../../shared/mobile-notification-identity'
import {
  isStructuredAttentionOrigin,
  type StructuredAttentionOrigin
} from '../../shared/agent-session-attention'

export type { DeliveredNotificationIdentity } from '../../shared/mobile-notification-identity'
export type DeliveredNotificationRecord = DeliveredNotificationIdentity & {
  structuredOrigin?: StructuredAttentionOrigin
}
type RecordEntry = DeliveredNotificationRecord & { dismissedThrough: number; expiresAt: number }
const LIMIT = 4096
const RETENTION_MS = 7 * 86400_000
const STALE_WRITE_TEMP_AGE_MS = 86400_000

export class MobileNotificationDismissalStore {
  private readonly path: string
  private entries: RecordEntry[] = []
  private unreadable = false
  private persisting: Promise<void> | null = null
  private persistAgain = false
  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'mobile-notification-dismissals.json')
    // Why: a write killed between writeFile and rename (e.g. a hung icacls, #20497) orphans its temp forever.
    void removeStaleDurableWriteTempFiles(this.path, { minimumAgeMs: STALE_WRITE_TEMP_AGE_MS })
    try {
      hardenExistingSecureFile(this.path)
      const value: unknown = JSON.parse(readFileSync(this.path, 'utf8'))
      if (Array.isArray(value)) {
        this.entries = value.flatMap(readEntry).slice(-LIMIT)
      }
    } catch (error) {
      this.unreadable = isUnreadableError(error)
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
    if (event.type === 'dismiss' && event.dismissedDelivery) {
      const target = event.dismissedDelivery
      next = kept.map((entry) =>
        entry.notificationId === target.notificationId &&
        entry.notificationEpoch === target.notificationEpoch
          ? {
              ...entry,
              dismissedThrough: Math.max(entry.dismissedThrough, target.notificationSeq),
              expiresAt: now + RETENTION_MS
            }
          : entry
      )
    } else if (event.type === 'notification') {
      next = [
        ...kept.filter((entry) => !same(entry)),
        {
          notificationId: event.notificationId,
          notificationEpoch: event.notificationEpoch,
          notificationSeq: event.notificationSeq,
          ...(event.structuredOrigin ? { structuredOrigin: event.structuredOrigin } : {}),
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
    this.entries = next
    if (!this.unreadable) {
      this.schedulePersist()
    }
  }

  liveDeliveries(prefix = ''): DeliveredNotificationRecord[] {
    const now = Date.now()
    return this.entries
      .filter(
        (entry) =>
          entry.expiresAt > now &&
          entry.notificationId.startsWith(prefix) &&
          entry.dismissedThrough < entry.notificationSeq
      )
      .map(({ notificationId, notificationEpoch, notificationSeq, structuredOrigin }) => ({
        notificationId,
        notificationEpoch,
        notificationSeq,
        ...(structuredOrigin ? { structuredOrigin } : {})
      }))
  }

  /** Resolves once every recorded change has been written or has failed to write. */
  flush(): Promise<void> {
    return this.persisting ?? Promise.resolve()
  }

  // Why async: record() runs on every notification, and a sync secure write blocks the main thread on icacls (#20497).
  private schedulePersist(): void {
    if (this.persisting) {
      this.persistAgain = true
      return
    }
    this.persisting = this.persistLatest()
  }

  private async persistLatest(): Promise<void> {
    try {
      do {
        this.persistAgain = false
        try {
          await writeSecureJsonFileAsync(this.path, this.entries)
        } catch {
          // Best-effort recovery state: the next record() rewrites the latest entries.
          console.warn('[notifications] Could not persist dismissal recovery state')
        }
      } while (this.persistAgain)
    } finally {
      // Cleared in the same turn as the last check, so a record() can never slip between them.
      this.persisting = null
    }
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

/** An origin this build cannot read (a newer cause kind) degrades to none; the record survives. */
function readEntry(value: unknown): RecordEntry[] {
  if (!isEntry(value)) {
    return []
  }
  const { structuredOrigin, ...entry } = value
  return [isStructuredAttentionOrigin(structuredOrigin) ? { ...entry, structuredOrigin } : entry]
}

function isEntry(
  value: unknown
): value is Omit<RecordEntry, 'structuredOrigin'> & { structuredOrigin?: unknown } {
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
