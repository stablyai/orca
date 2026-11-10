import { join } from 'node:path'
import {
  KeyedJsonRowCache,
  parseKeyedJsonRows
} from '../../../sqlite/row-cache/keyed-json-row-cache'
import { nextRetryDelayMs } from '../../../sqlite/row-cache/row-cache-failure'
import type { DeliveredNotificationIdentity } from '../../../../shared/mobile-notification-identity'
import {
  applyDismissalEvent,
  dismissalRows,
  DISMISSAL_LIMIT,
  isLiveDismissalEntry,
  readDismissalEntries,
  type DeliveredNotificationRecord,
  type DismissalEvent,
  type DismissalRecordEntry
} from './mobile-notification-dismissal-entries'

export type { DeliveredNotificationRecord } from './mobile-notification-dismissal-entries'

const DATABASE_FILE = 'mobile-notification-dismissals.db'
// Earlier builds rewrote this whole file per alert; it is imported once, then removed.
const LEGACY_FILE = 'mobile-notification-dismissals.json'
const RETRY_BACKOFF = { minMs: 100, maxMs: 60_000 }

function warnPersistFailed(error: unknown): void {
  console.warn('[notifications] Could not persist dismissal recovery state', error)
}

type PendingEvent = { event: DismissalEvent & { notificationId: string }; at: number }

/**
 * One SQLite row per delivery, so each alert or dismissal saves only the rows it changed.
 * Until stored history is read it is never replaced: events queue and merge into it once a
 * retry reads it, and meanwhile any delivery may still be live.
 */
export class MobileNotificationDismissalStore {
  private entries: DismissalRecordEntry[] = []
  private historyKnown = false
  private readonly pending: PendingEvent[] = []
  private dirty = false
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private retryDelayMs = 0
  private closed = false
  // Notification ids need no secure writer; its synchronous Windows icacls froze windows per alert (STA-9692).
  private readonly cache: KeyedJsonRowCache

  constructor(userDataPath: string) {
    this.cache = new KeyedJsonRowCache(join(userDataPath, DATABASE_FILE), {
      schemaVersion: 1,
      legacyPath: join(userDataPath, LEGACY_FILE)
    })
    const unread = this.hydrate()
    if (unread) {
      // Show what an older build's file says while the stored history stays unread.
      this.entries = unread.legacy ?? []
      this.scheduleRetry()
    }
  }

  record(event: DismissalEvent): void {
    const { notificationId } = event
    if (!notificationId) {
      return
    }
    const now = Date.now()
    this.entries = applyDismissalEvent(this.entries, { ...event, notificationId }, now)
    if (!this.historyKnown) {
      this.pending.push({ event: { ...event, notificationId }, at: now })
      this.pending.splice(0, Math.max(0, this.pending.length - DISMISSAL_LIMIT))
      if (this.closed) {
        // No retry timer runs after close: one bounded attempt, keeping the event on failure.
        this.attempt()
      }
      return
    }
    this.dirty = true
    if (!this.persist() && !this.closed) {
      this.scheduleRetry()
    }
  }

  /** One bounded attempt to read unread history and save what is pending. */
  flush(): Promise<void> {
    this.attempt()
    return Promise.resolve()
  }

  /** Saves what it can and releases the database; later records still save per write. */
  close(): Promise<void> {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
    this.attempt()
    this.closed = true
    this.cache.close()
    return Promise.resolve()
  }

  /** Unread history cannot rule a delivery out. */
  hasLiveDelivery(notificationId: string): boolean {
    const now = Date.now()
    return (
      !this.historyKnown ||
      this.entries.some(
        (entry) => entry.notificationId === notificationId && isLiveDismissalEntry(entry, now)
      )
    )
  }

  liveDeliveries(): DeliveredNotificationRecord[] {
    const now = Date.now()
    return this.entries
      .filter((entry) => isLiveDismissalEntry(entry, now))
      .map(
        ({
          notificationId,
          notificationEpoch,
          notificationSeq,
          structuredOrigin,
          workspaceExecutionHostId,
          worktreeId,
          paneKey,
          executionHost
        }) => ({
          notificationId,
          notificationEpoch,
          notificationSeq,
          ...(structuredOrigin ? { structuredOrigin } : {}),
          ...(worktreeId ? { worktreeId } : {}),
          ...(paneKey ? { paneKey } : {}),
          ...(workspaceExecutionHostId !== undefined ? { workspaceExecutionHostId } : {}),
          ...(executionHost ? { executionHost } : {})
        })
      )
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

  /** Returns why history stays unread, or undefined once it is read and merged. */
  private hydrate(): { legacy?: DismissalRecordEntry[] } | undefined {
    // A file still present came from an older build unless its receipt shows it was imported.
    const loaded = this.cache.load(readLegacyHistory)
    if (loaded.kind === 'unavailable') {
      console.warn('[notifications] Could not read dismissal recovery state', loaded.error)
      return { legacy: loaded.legacy }
    }
    let entries: DismissalRecordEntry[]
    if (loaded.kind === 'import') {
      try {
        this.cache.write(dismissalRows(loaded.value), { importReceipt: loaded.receipt })
      } catch (error) {
        console.warn('[notifications] Could not read dismissal recovery state', error)
        return { legacy: loaded.value }
      }
      entries = loaded.value
    } else {
      entries = readDismissalEntries(parseKeyedJsonRows(loaded.rows).map(({ value }) => value))
    }
    for (const { event, at } of this.pending) {
      entries = applyDismissalEvent(entries, event, at)
    }
    this.dirty = this.pending.length > 0
    this.pending.length = 0
    this.entries = entries
    this.historyKnown = true
    return undefined
  }

  private persist(): boolean {
    if (!this.dirty || !this.historyKnown) {
      return true
    }
    try {
      this.cache.write(dismissalRows(this.entries))
      this.dirty = false
      this.retryDelayMs = 0
      return true
    } catch (error) {
      warnPersistFailed(error)
      return false
    }
  }

  private attempt(): boolean {
    if (!this.historyKnown && this.hydrate()) {
      return false
    }
    return this.persist()
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.closed) {
      return
    }
    this.retryDelayMs = nextRetryDelayMs(this.retryDelayMs, RETRY_BACKOFF)
    const delay = this.retryDelayMs
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (!this.attempt()) {
        this.scheduleRetry()
      }
    }, delay)
    const timer: unknown = this.retryTimer
    if (
      typeof timer === 'object' &&
      timer !== null &&
      'unref' in timer &&
      typeof timer.unref === 'function'
    ) {
      timer.unref()
    }
  }
}

/** History an older build wrote; corrupt bytes are rejected and never replace stored rows. */
function readLegacyHistory(text: string): DismissalRecordEntry[] | null {
  const value: unknown = JSON.parse(text)
  return Array.isArray(value) ? readDismissalEntries(value) : null
}
