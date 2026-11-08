import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isStructuredAgentSessionStopNote } from '../agent-session-wire/operations/structured-agent-session-command-turn'
import { projectJournalStopNote } from './context-epochs/journal-stop-note-projection'

type HistoryTarget = { sessionId: string; epoch: string }

/** The caller's snapshot includes both the note and the turn that supersedes its failure. */
export function projectJournalDomainStopNote(
  db: Database.Database,
  target: HistoryTarget,
  item: AgentJournalRenderItem
): AgentJournalRenderItem {
  const get = (id: string): AgentJournalRenderItem | undefined => {
    const row = db
      .prepare(`SELECT payload_json FROM journal_items
      WHERE session_id=? AND epoch=? AND item_id=?`)
      .get(target.sessionId, target.epoch, id)
    return row ? JSON.parse(String(row.payload_json)) : undefined
  }
  return projectJournalStopNote(item, { get, has: (id) => get(id) !== undefined })
}

export function journalDomainDependentStopNotes(
  db: Database.Database,
  target: HistoryTarget,
  turnItemIds: ReadonlySet<string>
): string[] {
  return db
    .prepare(`SELECT item.item_id FROM json_each(?) wanted
    CROSS JOIN journal_items item
    WHERE item.session_id=? AND item.epoch=? AND item.hidden=0
      AND json_extract(item.payload_json, '$.turnScope.turnItemId')=wanted.value
      AND json_extract(item.payload_json, '$.body.kind')='status'
      AND json_extract(item.payload_json, '$.body.failure.kind')='cancelUnconfirmed'`)
    .all(JSON.stringify([...turnItemIds]), target.sessionId, target.epoch)
    .map((row) => String(row.item_id))
    .filter(isStructuredAgentSessionStopNote)
}
