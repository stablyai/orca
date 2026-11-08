import type Database from '../../sqlite/sync-database'

export type JournalDomainMaintenance =
  | { kind: 'domain-retired-prune'; sessionId: string; epoch: string }
  | { kind: 'page-reclaim' }
  | { kind: 'compaction-state' }
  | { kind: 'compaction-complete'; now: number }

export type JournalDomainMaintenanceResult =
  | { kind: 'domain-retired'; deleted: number; more: boolean }
  | { kind: 'page-reclaim'; more: boolean }
  | { kind: 'compaction-state'; completedAt: number | null }

// Only a ready head naming another epoch proves retirement; an interrupted import has no head.
const RETIRED_TABLES = [
  { name: 'journal_items', key: 'item_id' },
  { name: 'journal_item_subagent_names', key: 'subagent_id,item_id' },
  { name: 'journal_item_tombstones', key: 'item_id' },
  { name: 'journal_item_aliases', key: 'provider_item_id' },
  { name: 'journal_submission_attempts', key: 'message_id,attempt_sequence,attempt_index' },
  { name: 'journal_send_receipts', key: 'message_id' },
  { name: 'journal_queue_cards', key: 'message_id' },
  { name: 'journal_edit_leases', key: 'owner_id,caller_key,edit_id' },
  { name: 'journal_provider_activity', key: 'fence' },
  { name: 'journal_events', key: 'sequence' }
] as const

export function pruneJournalDomainRetiredPage(
  db: Database.Database,
  target: { sessionId: string; epoch: string }
): JournalDomainMaintenanceResult {
  const head = db
    .prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?')
    .get(target.sessionId)
  if (head?.epoch !== target.epoch) {
    return { kind: 'domain-retired', deleted: 0, more: false }
  }
  let remaining = 50
  for (const { name, key } of RETIRED_TABLES) {
    // Separate ranges seek past the current epoch rather than scanning its live rows.
    for (const comparison of ['<', '>']) {
      const result = db
        .prepare(`DELETE FROM ${name} WHERE (session_id,epoch,${key}) IN (
        SELECT session_id,epoch,${key} FROM ${name}
        WHERE session_id=? AND epoch${comparison}?
        LIMIT ?
      )`)
        .run(target.sessionId, target.epoch, remaining)
      remaining -= Number(result.changes)
      if (remaining === 0) {
        return { kind: 'domain-retired', deleted: 50, more: true }
      }
    }
  }
  return { kind: 'domain-retired', deleted: 50 - remaining, more: false }
}

/** One page in the admitted writer transaction, with no checkpoint or alternate admission path. */
export function reclaimJournalDomainPage(db: Database.Database): JournalDomainMaintenanceResult {
  const free = Number(db.pragma('freelist_count', { simple: true }))
  if (free > 0) {
    db.exec('PRAGMA incremental_vacuum(1)')
  }
  return { kind: 'page-reclaim', more: free > 1 }
}

export function journalDomainCompactionState(
  db: Database.Database
): JournalDomainMaintenanceResult {
  const row = db.prepare('SELECT compacted_at FROM journal_maintenance WHERE id=1').get()
  return { kind: 'compaction-state', completedAt: row ? Number(row.compacted_at) : null }
}

export function completeJournalDomainCompaction(
  db: Database.Database,
  now: number
): JournalDomainMaintenanceResult {
  db.prepare(`INSERT INTO journal_maintenance(id,compacted_at) VALUES(1,?)
    ON CONFLICT(id) DO UPDATE SET compacted_at=excluded.compacted_at`).run(now)
  return { kind: 'compaction-state', completedAt: now }
}
