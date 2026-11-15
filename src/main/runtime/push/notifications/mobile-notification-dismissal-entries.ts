import type { MobileNotificationEvent } from './runtime-mobile-notification-controller'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { DeliveredNotificationIdentity } from '../../../../shared/mobile-notification-identity'
import type { KeyedJsonRow } from '../../../sqlite/row-cache/keyed-json-row-cache'
import {
  isStructuredAttentionOrigin,
  type StructuredAttentionOrigin
} from '../../../../shared/agent-session/agent-session-attention'

export type DeliveredNotificationRecord = DeliveredNotificationIdentity & {
  structuredOrigin?: StructuredAttentionOrigin
  worktreeId?: string
  paneKey?: string
  workspaceExecutionHostId?: ExecutionHostId | null
  executionHost?: `runtime:${string}`
}
export type DismissalRecordEntry = DeliveredNotificationRecord & {
  dismissedThrough: number
  expiresAt: number
}
export type DismissalEvent = MobileNotificationEvent & {
  notificationEpoch: string
  notificationSeq: number
}
type RecordEntry = DismissalRecordEntry

export const DISMISSAL_LIMIT = 4096
const RETENTION_MS = 7 * 86400_000

/** The history after `event` at `now`: expired records drop, the newest LIMIT remain. */
export function applyDismissalEvent(
  entries: readonly RecordEntry[],
  event: DismissalEvent & { notificationId: string },
  now: number
): RecordEntry[] {
  const kept = entries.filter((entry) => entry.expiresAt > now)
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
        ...(event.workspaceExecutionHostId !== undefined
          ? { workspaceExecutionHostId: event.workspaceExecutionHostId }
          : {}),
        ...(event.worktreeId ? { worktreeId: event.worktreeId } : {}),
        ...(event.paneKey ? { paneKey: event.paneKey } : {}),
        ...(event.executionHost ? { executionHost: event.executionHost } : {}),
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
  return next.slice(-DISMISSAL_LIMIT)
}

/** Records from a stored row or an older build's file; unusable ones are dropped. */
export function readDismissalEntries(values: readonly unknown[]): RecordEntry[] {
  return values.flatMap(readEntry).slice(-DISMISSAL_LIMIT)
}

/** Rows keyed by delivery identity; a repeated identity keeps its last position. */
export function dismissalRows(entries: readonly RecordEntry[]): KeyedJsonRow[] {
  const rows = new Map<string, KeyedJsonRow>()
  for (const entry of entries) {
    const key = `${entry.notificationId}\u0000${entry.notificationEpoch}`
    rows.delete(key)
    rows.set(key, { key, json: JSON.stringify(entry) })
  }
  return [...rows.values()]
}

export function isLiveDismissalEntry(entry: RecordEntry, now: number): boolean {
  return entry.expiresAt > now && entry.dismissedThrough < entry.notificationSeq
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
