import type { OrchestrationDb } from '../orchestration-db'
import { UNKNOWN_MAIL_HANDOFF } from '../../mail-handoff'

export function migrateV44(this: OrchestrationDb, current: number): void {
  if (current >= 44) {
    return
  }
  if (!this.hasColumn('messages', 'handoff')) {
    this.db.exec('ALTER TABLE messages ADD COLUMN handoff TEXT')
  }
  if (!this.hasColumn('messages', 'recovery_used')) {
    this.db.exec('ALTER TABLE messages ADD COLUMN recovery_used INTEGER NOT NULL DEFAULT 0')
  }
  // Prior reads and ambiguous sends have no saved latest consumer; never replay past an unknown Stop.
  this.db
    .prepare(`UPDATE messages SET handoff = ? WHERE handoff IS NULL AND (
    delivered_at IS NOT NULL OR pointer_enter_pending > 1 OR
    id IN (SELECT m.value FROM deliveries d, json_each(d.message_ids) m)
  )`)
    .run(UNKNOWN_MAIL_HANDOFF)
  // Until the old journal supplies exact membership, only pre-upgrade mail is uncertain.
  this.db.exec(`UPDATE messages SET handoff = json_object('version', 1, 'kind', 'legacy',
      'operationId', (SELECT operation_id FROM structured_pointer_operations o
        WHERE o.mailbox_handle = messages.to_handle))
    WHERE handoff IS NULL AND EXISTS (SELECT 1 FROM structured_pointer_operations o
      WHERE o.mailbox_handle = messages.to_handle)`)
}
