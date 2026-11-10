import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isStructuredAgentSessionStopNote } from '../agent-session-wire/operations/structured-agent-session-command-turn'
import { projectJournalStopNote } from './context-epochs/journal-stop-note-projection'
import { journalDomainItemWire } from './journal-domain-history-metadata'
import { journalDomainOutlineSource } from './journal-domain-outline-source'

type Target = { sessionId: string; epoch: string }

/** Keep the exact source status when the turn's current state changes its display. */
export function journalDomainStopNote(
  item: AgentJournalRenderItem,
  get: (id: string) => AgentJournalRenderItem | undefined
): {
  item: AgentJournalRenderItem
  turnItemId: string | null
  originalStopNoteJson: string | null
} {
  if (
    item.body.kind !== 'status' ||
    item.body.failure?.kind !== 'cancelUnconfirmed' ||
    item.turnScope?.kind !== 'turn' ||
    !isStructuredAgentSessionStopNote(item.itemId)
  ) {
    return { item, turnItemId: null, originalStopNoteJson: null }
  }
  return {
    item: projectJournalStopNote(item, { get, has: (id) => get(id) !== undefined }),
    turnItemId: item.turnScope.turnItemId,
    originalStopNoteJson: JSON.stringify(item.body)
  }
}

/** The turn's owning transaction refreshes display without changing source revision or placement. */
export function refreshJournalDomainStopNotes(
  db: Database.Database,
  target: Target,
  turnItemIds: readonly string[]
): AgentJournalRenderItem[] {
  const prefix = [target.sessionId, target.epoch] as const
  const notes = db
    .prepare(`SELECT item.payload_json, ${journalDomainFullDisplaySql('item')} AS display_json FROM json_each(?) wanted
      CROSS JOIN journal_items item
      WHERE item.session_id=? AND item.epoch=? AND item.hidden=0
        AND item.turn_item_id=wanted.value AND item.turn_item_id IS NOT NULL
        AND item.original_stop_note_json IS NOT NULL`)
    .all(JSON.stringify(turnItemIds), ...prefix)
  const turn = db.prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=?`)
  const get = (id: string): AgentJournalRenderItem | undefined => {
    const row = turn.get(...prefix, id)
    return row ? JSON.parse(String(row.payload_json)) : undefined
  }
  const update =
    db.prepare(`UPDATE journal_items SET wire_bytes=?,wire_json=?,detail_json=?,outline_source_json=?
    WHERE session_id=? AND epoch=? AND item_id=?`)
  const changed: AgentJournalRenderItem[] = []
  for (const row of notes) {
    const source: AgentJournalRenderItem = JSON.parse(String(row.payload_json))
    const prior: AgentJournalRenderItem = JSON.parse(String(row.display_json))
    const next = projectJournalStopNote(source, { get, has: (id) => get(id) !== undefined })
    if (JSON.stringify(next.body) === JSON.stringify(prior.body)) {
      continue
    }
    const wire = journalDomainItemWire(source, String(row.payload_json), next)
    update.run(
      wire.wireBytes,
      wire.wireJson,
      wire.detailJson,
      journalDomainOutlineSource(next),
      ...prefix,
      next.itemId
    )
    changed.push(next)
  }
  return changed
}

/** Full semantic readers use the saved Stop rewrite, never a normal shortened wire head. */
export function journalDomainFullDisplaySql(alias = ''): string {
  const p = alias ? `${alias}.` : ''
  return `CASE WHEN ${p}original_stop_note_json IS NOT NULL AND ${p}wire_json IS NOT NULL
    AND json_extract(${p}wire_json,'$.body.kind')='status'
    AND json_type(${p}wire_json,'$.body.failure') IS NULL
    THEN ${p}wire_json ELSE ${p}payload_json END`
}
