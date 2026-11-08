import type Database from '../../sqlite/sync-database'

export type JournalDomainImportDiscard = { more: boolean; epoch: string | null }

/** An unready import owns only these chat rows; profile metadata and ready chats are untouched. */
export function discardJournalDomainImportPage(
  db: Database.Database,
  sessionId: string
): JournalDomainImportDiscard {
  if (!db.isTransaction) {
    throw new Error('journal import discard requires its writer transaction')
  }
  const ready = db.prepare('SELECT epoch FROM journal_chat_state WHERE session_id=?').get(sessionId)
  if (ready?.epoch !== null && ready?.epoch !== undefined) {
    return { more: false, epoch: String(ready.epoch) }
  }
  let remaining = 512
  for (const [table, key] of [
    ['journal_item_subagent_names', 'epoch,subagent_id,item_id'],
    ['journal_items', 'epoch,item_id'],
    ['journal_item_tombstones', 'epoch,item_id'],
    ['journal_removed_turns', 'epoch,turn_id'],
    ['journal_item_aliases', 'epoch,provider_item_id'],
    ['journal_submission_attempts', 'epoch,message_id,attempt_sequence,attempt_index'],
    ['journal_send_receipts', 'epoch,message_id'],
    ['journal_settlements', 'epoch,settlement_id'],
    ['journal_input_end_observations', 'epoch,source_item_key'],
    ['journal_queue_cards', 'epoch,message_id'],
    ['journal_queue_clear_members', 'epoch,message_id'],
    ['journal_edit_leases', 'epoch,owner_id,caller_key,edit_id'],
    ['journal_provider_activity', 'epoch,fence'],
    ['journal_events', 'epoch,sequence']
  ]) {
    const result = db
      .prepare(`DELETE FROM ${table} WHERE session_id=? AND (${key}) IN (
        SELECT ${key} FROM ${table} WHERE session_id=? ORDER BY ${key} LIMIT ?
      )`)
      .run(sessionId, sessionId, remaining)
    remaining -= Number(result.changes)
    if (remaining === 0) {
      return { more: true, epoch: null }
    }
  }
  return { more: false, epoch: null }
}
