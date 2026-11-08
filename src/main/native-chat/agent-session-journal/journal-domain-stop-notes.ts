import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isStructuredAgentSessionStopNote } from '../agent-session-wire/operations/structured-agent-session-command-turn'
import { projectJournalStopNote } from './context-epochs/journal-stop-note-projection'
import {
  JOURNAL_DOMAIN_ITEM_COLUMNS,
  journalDomainItemColumns
} from './journal-domain-item-read-columns'

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

/** The turn's owning transaction also revises its visible notes, without moving them. */
export function refreshJournalDomainStopNotes(
  db: Database.Database,
  target: Target,
  turnItemIds: readonly string[]
): AgentJournalRenderItem[] {
  const prefix = [target.sessionId, target.epoch] as const
  const notes = db
    .prepare(`SELECT item.payload_json, item.original_stop_note_json FROM json_each(?) wanted
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
  const update = db.prepare(`UPDATE journal_items SET revision=?, payload_json=?,
    ${JOURNAL_DOMAIN_ITEM_COLUMNS.map((column) => `${column}=?`).join(',')}
    WHERE session_id=? AND epoch=? AND item_id=?`)
  const changed: AgentJournalRenderItem[] = []
  for (const row of notes) {
    const prior: AgentJournalRenderItem = JSON.parse(String(row.payload_json))
    const original: AgentJournalRenderItem = {
      ...prior,
      body: JSON.parse(String(row.original_stop_note_json))
    }
    const projected = projectJournalStopNote(original, { get, has: (id) => get(id) !== undefined })
    if (JSON.stringify(projected.body) === JSON.stringify(prior.body)) {
      continue
    }
    const next = { ...projected, revision: prior.revision + 1 }
    const payload = JSON.stringify(next)
    update.run(
      next.revision,
      payload,
      ...journalDomainItemColumns(next, payload).values,
      ...prefix,
      next.itemId
    )
    changed.push(next)
  }
  return changed
}
