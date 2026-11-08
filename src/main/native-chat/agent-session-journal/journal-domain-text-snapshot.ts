import { isDeepStrictEqual } from 'node:util'
import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { journalItemStatusMetadata } from './journal-item-status-metadata'

/** Stable text placement and classifications need no membership or indexed-column rewrite. */
export function writeJournalDomainTextSnapshot(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  stored: SqliteRow | undefined,
  item: AgentJournalRenderItem,
  ownerFence: number,
  executionOwner: number | null
): boolean {
  if (
    !stored ||
    stored.payload_json !== null ||
    item.body.kind !== 'message' ||
    stored.message_role !== item.body.role ||
    stored.lifecycle_state !== (item.body.state ?? null) ||
    Number(stored.owner_fence) !== ownerFence ||
    (stored.execution_owner == null ? null : Number(stored.execution_owner)) !== executionOwner
  ) {
    return false
  }
  const [, , , prose] = journalItemStatusMetadata(item)
  if (Number(stored.assistant_prose) !== prose) {
    return false
  }
  const { revision: _previousRevision, ...previousPlacement } = JSON.parse(
    String(stored.placement_json)
  )
  const { revision, body: _body, ...placement } = item
  if (!isDeepStrictEqual(previousPlacement, placement)) {
    return false
  }
  const payload = JSON.stringify(item)
  const { wireBytes } = journalDomainHistoryMetadata(item, payload)
  db.prepare(`UPDATE journal_items SET payload_json=?,revision=?,sequence=?,wire_bytes=?
    WHERE session_id=? AND epoch=? AND item_id=?`).run(
    payload,
    revision,
    item.sequence,
    wireBytes,
    target.sessionId,
    target.epoch,
    item.itemId
  )
  return true
}
