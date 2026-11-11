import {
  readJournalDomainStopStates,
  resolveJournalDomainDisplay,
  journalDomainDisplayTurnState
} from './journal-domain-item-display'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { isStructuredAgentSessionStopNote } from '../../../shared/agent-session/view/structured-agent-session-stop-note-identity'
import { projectJournalStopNote } from './context-epochs/journal-stop-note-projection'
import { journalDomainItemWire } from './journal-domain-item-wire'
import { journalDomainOutlineSource } from './journal-domain-outline-source'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'

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
    .prepare(`SELECT item.item_id,item.payload_json,item.wire_version,item.wire_json AS display_json FROM json_each(?) wanted
      CROSS JOIN journal_items item
      WHERE item.session_id=? AND item.epoch=? AND item.hidden=0
        AND item.turn_item_id=wanted.value AND item.turn_item_id IS NOT NULL
        AND item.original_stop_note_json IS NOT NULL`)
    .all(JSON.stringify(turnItemIds), ...prefix)
  const states = readJournalDomainStopStates(
    db,
    target,
    notes.map((row) => String(row.item_id))
  )
  const turn = db.prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=?`)
  const get = (id: string): AgentJournalRenderItem | undefined => {
    const row = turn.get(...prefix, id)
    return row ? JSON.parse(String(row.payload_json)) : undefined
  }
  const update =
    db.prepare(`UPDATE journal_items SET wire_version=?,wire_bytes=?,wire_json=?,detail_json=?,outline_source_json=?
    WHERE session_id=? AND epoch=? AND item_id=?`)
  const changed: AgentJournalRenderItem[] = []
  for (const row of notes) {
    const source: AgentJournalRenderItem = JSON.parse(String(row.payload_json))
    const prior: AgentJournalRenderItem =
      row.wire_version === AGENT_SESSION_ITEM_WIRE_VERSION
        ? resolveJournalDomainDisplay(source, row.wire_version, row.display_json, undefined)
        : resolveJournalDomainDisplay(
            source,
            row.wire_version,
            null,
            journalDomainDisplayTurnState(source, states)
          )
    const next = projectJournalStopNote(source, { get, has: (id) => get(id) !== undefined })
    const same = JSON.stringify(next.body) === JSON.stringify(prior.body)
    if (same && row.wire_version === AGENT_SESSION_ITEM_WIRE_VERSION) {
      continue
    }
    const wire = journalDomainItemWire(source, String(row.payload_json), next)
    update.run(
      wire.wireVersion,
      wire.wireBytes,
      wire.wireJson,
      wire.detailJson,
      journalDomainOutlineSource(next),
      ...prefix,
      next.itemId
    )
    if (!same) {
      changed.push(next)
    }
  }
  return changed
}
