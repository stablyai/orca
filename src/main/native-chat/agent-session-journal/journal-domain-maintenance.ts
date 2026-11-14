import { journalForkStageEpochs } from './journal-fork-stage-state'
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

const RETIRED_PAGE_BYTES = 1024 * 1024
// Only a ready head naming another epoch proves retirement; import shells have no epoch.
export const JOURNAL_EPOCH_TABLES: readonly {
  name: string
  key: string
  payload?: readonly string[]
}[] = [
  {
    name: 'journal_items',
    key: 'item_id',
    payload: [
      'payload_json',
      'original_stop_note_json',
      'wire_json',
      'detail_json',
      'outline_source_json'
    ]
  },
  { name: 'journal_outline_cache', key: '', payload: ['outline_json'] },
  { name: 'journal_item_subagent_names', key: 'subagent_id,item_id' },
  { name: 'journal_item_tombstones', key: 'item_id' },
  { name: 'journal_removed_turns', key: 'turn_id' },
  { name: 'journal_item_aliases', key: 'provider_item_id', payload: ['echo_json'] },
  {
    name: 'journal_submission_attempts',
    key: 'message_id,attempt_sequence,attempt_index',
    payload: ['payload_json']
  },
  { name: 'journal_send_receipts', key: 'message_id', payload: ['payload_json'] },
  { name: 'journal_settlements', key: 'settlement_id' },
  { name: 'journal_input_end_observations', key: 'source_item_key', payload: ['observation_json'] },
  { name: 'journal_queue_cards', key: 'message_id', payload: ['payload_json'] },
  { name: 'journal_queue_clear_members', key: 'message_id' },
  { name: 'journal_edit_leases', key: 'owner_id,caller_key,edit_id' },
  { name: 'journal_provider_activity', key: 'fence' },
  { name: 'journal_events', key: 'sequence', payload: ['changes_json'] }
]

export function pruneJournalDomainRetiredPage(
  db: Database.Database,
  target: { sessionId: string; epoch: string }
): JournalDomainMaintenanceResult {
  const head = db
    .prepare('SELECT epoch FROM journal_chat_state WHERE session_id=? AND epoch IS NOT NULL')
    .get(target.sessionId)
  if (head?.epoch !== target.epoch) {
    return { kind: 'domain-retired', deleted: 0, more: false }
  }
  const held = journalForkStageEpochs(db, target.sessionId)
  const start = performance.now()
  let deleted = 0
  let bytes = 0
  for (const { name, key, payload } of JOURNAL_EPOCH_TABLES) {
    const columns = ['session_id', 'epoch', ...(key ? key.split(',') : [])]
    const sizes = [...columns, ...(payload ?? [])]
      .map((column) => `COALESCE(octet_length(${column}),0)`)
      .join('+')
    const remove = db.prepare(
      `DELETE FROM ${name} WHERE ${columns.map((column) => `${column}=?`).join(' AND ')}`
    )
    // Separate ranges seek past the current epoch rather than scanning its live rows.
    for (const comparison of ['<', '>']) {
      // octet_length(column) reads stored lengths without loading overflow payloads.
      const rows = db
        .prepare(`SELECT ${columns.join(',')},${sizes} AS work_bytes FROM ${name}
        WHERE session_id=? AND epoch${comparison}? AND epoch NOT IN (SELECT value FROM json_each(?))
        LIMIT ?`)
        .all(target.sessionId, target.epoch, JSON.stringify(held), 50 - deleted)
      for (const row of rows) {
        const size = Number(row.work_bytes)
        if (deleted > 0 && bytes + size > RETIRED_PAGE_BYTES) {
          return { kind: 'domain-retired', deleted, more: true }
        }
        deleted += Number(remove.run(...columns.map((column) => row[column])).changes)
        bytes += size
        // An oversized row progresses alone; it must not bring another row into its unit.
        if (deleted === 50 || bytes >= RETIRED_PAGE_BYTES || performance.now() - start >= 8) {
          return { kind: 'domain-retired', deleted, more: true }
        }
      }
    }
  }
  return { kind: 'domain-retired', deleted, more: false }
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
