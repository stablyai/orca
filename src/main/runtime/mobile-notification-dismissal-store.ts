import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUnreadableError } from '../../shared/secure-file'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'
import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import type { DeliveredNotificationIdentity } from '../../shared/mobile-notification-identity'
import {
  isStructuredAttentionOrigin,
  type StructuredAttentionOrigin
} from '../../shared/agent-session-attention'

export type DeliveredNotificationRecord = DeliveredNotificationIdentity & {
  structuredOrigin?: StructuredAttentionOrigin
}
type RecordEntry = DeliveredNotificationRecord & { dismissedThrough: number; expiresAt: number }
const LIMIT = 4096
const RETENTION_MS = 7 * 86400_000

function warnPersistFailed(error: unknown): void {
  console.warn('[notifications] Could not persist dismissal recovery state', error)
}

export class MobileNotificationDismissalStore {
  private readonly path: string
  private entries: RecordEntry[] = []
  private unreadable = false
  private closed = false
  // Notification ids need no secure writer; its synchronous Windows icacls froze windows per alert (STA-9692).
  private readonly writer: AtomicSnapshotWriter
  constructor(userDataPath: string) {
    this.path = join(userDataPath, 'mobile-notification-dismissals.json')
    this.writer = new AtomicSnapshotWriter(() => this.path, { fileMode: 0o600 })
    try {
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
    if (this.unreadable) {
      return
    }
    const serialize = () => JSON.stringify(this.entries, null, 2)
    if (this.closed) {
      // Exit would drop an asynchronous write.
      try {
        this.writer.writeSync(serialize)
      } catch (error) {
        warnPersistFailed(error)
      }
      return
    }
    this.writer.write(serialize).catch(warnPersistFailed)
  }

  flush(): Promise<void> {
    return this.writer.waitForPendingWrite().catch(() => {})
  }

  /** Committed exits only: subsequent records write synchronously; wait for the pending write. */
  close(): Promise<void> {
    this.closed = true
    return this.flush()
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

/** Keep records with unknown future origin kinds, degrading only their origin to none. */
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
