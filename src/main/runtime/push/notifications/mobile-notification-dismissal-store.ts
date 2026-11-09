import { join } from 'node:path'
import { KeyedJsonRowCache, type KeyedJsonRowImport } from '../../../sqlite/keyed-json-row-cache'
import {
  readLegacyJsonSource,
  removeImportedLegacyJsonSource
} from '../../../sqlite/legacy-json-source'
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
const RETRY_DELAYS_MS = [100, 1_000, 5_000, 30_000, 60_000] as const

function warnPersistFailed(error: unknown): void {
  console.warn('[notifications] Could not persist dismissal recovery state', error)
}

type PendingEvent = { event: DismissalEvent & { notificationId: string }; at: number }
type LegacyHistory = KeyedJsonRowImport & { entries: DismissalRecordEntry[] }

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
  private retryAttempt = 0
  private closed = false
  // Notification ids need no secure writer; its synchronous Windows icacls froze windows per alert (STA-9692).
  private readonly cache: KeyedJsonRowCache
  private readonly legacyPath: string

  constructor(userDataPath: string) {
    this.cache = new KeyedJsonRowCache(join(userDataPath, DATABASE_FILE), 1)
    this.legacyPath = join(userDataPath, LEGACY_FILE)
    const unread = this.hydrate()
    if (unread) {
      // Show what an older build's file says while the stored history stays unread.
      this.entries = unread.legacy?.entries ?? []
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
  private hydrate(): { legacy?: LegacyHistory } | undefined {
    const source = readLegacyJsonSource(this.legacyPath)
    if (source.kind === 'unreadable') {
      console.warn('[notifications] Could not read dismissal recovery state', source.error)
      return {}
    }
    const legacy =
      source.kind === 'read' ? readLegacyHistory(source.text, source.receipt) : undefined
    // A file still present came from an older build unless its receipt shows it was imported.
    const loaded = this.cache.load(legacy)
    if (loaded.kind === 'unreadable') {
      console.warn('[notifications] Could not read dismissal recovery state', loaded.error)
      return { legacy }
    }
    let entries = readDismissalEntries(loaded.values)
    for (const { event, at } of this.pending) {
      entries = applyDismissalEvent(entries, event, at)
    }
    this.dirty = this.pending.length > 0
    this.pending.length = 0
    this.entries = entries
    this.historyKnown = true
    if (legacy) {
      removeImportedLegacyJsonSource(this.legacyPath, legacy.receipt)
    }
    return undefined
  }

  private persist(): boolean {
    if (!this.dirty || !this.historyKnown) {
      return true
    }
    try {
      this.cache.write(dismissalRows(this.entries))
      this.dirty = false
      this.retryAttempt = 0
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
    const delay = RETRY_DELAYS_MS[Math.min(this.retryAttempt, RETRY_DELAYS_MS.length - 1)]
    this.retryAttempt += 1
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

function readLegacyHistory(text: string, receipt: string): LegacyHistory {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // Corrupt history establishes nothing, like missing history.
    value = []
  }
  const entries = readDismissalEntries(Array.isArray(value) ? value : [])
  return { entries, rows: dismissalRows(entries), receipt }
}
