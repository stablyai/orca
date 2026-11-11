import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'
import { projectJournalStopNoteForTurnState } from './context-epochs/journal-stop-note-projection'

export type JournalDomainItemTarget = { sessionId: string; epoch: string }

/** Semantic readers retain full source bodies; only the saved Stop rewrite may replace them. */
export function resolveJournalDomainDisplay(
  source: AgentJournalRenderItem,
  version: unknown,
  saved: unknown,
  turnState: unknown
): AgentJournalRenderItem {
  if (version !== AGENT_SESSION_ITEM_WIRE_VERSION) {
    return projectJournalStopNoteForTurnState(source, turnState)
  }
  if (
    source.body.kind === 'status' &&
    source.body.failure?.kind === 'cancelUnconfirmed' &&
    saved !== null &&
    saved !== undefined
  ) {
    const display: AgentJournalRenderItem = JSON.parse(String(saved))
    if (display.body.kind === 'status' && display.body.failure === undefined) {
      return display
    }
  }
  return source
}

/** Distinct owning-turn facts for this bounded set, including provider aliases, share its snapshot. */
export function readJournalDomainStopStates(
  db: Database.Database,
  target: JournalDomainItemTarget,
  ids: readonly string[]
): Map<string, unknown> {
  if (ids.length === 0) {
    return new Map()
  }
  const turns = [
    ...new Set(
      db
        .prepare(`SELECT item.turn_item_id FROM json_each(?) wanted
    CROSS JOIN journal_items item WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value
      AND item.wire_version IS NOT ${AGENT_SESSION_ITEM_WIRE_VERSION} AND item.turn_item_id IS NOT NULL
      AND item.original_stop_note_json IS NOT NULL`)
        .all(JSON.stringify(ids), target.sessionId, target.epoch)
        .map((row) => String(row.turn_item_id))
    )
  ]
  if (turns.length === 0) {
    return new Map()
  }
  return new Map(
    db
      .prepare(`SELECT wanted.value AS turn_item_id,
    CASE json_extract(turn.payload_json,'$.body.kind')
      WHEN 'turn' THEN json_extract(turn.payload_json,'$.body.state')
      WHEN 'status' THEN json_extract(turn.payload_json,'$.body.turnLifecycle.state') END AS state
    FROM json_each(?) wanted
    LEFT JOIN journal_item_aliases alias ON alias.session_id=?2 AND alias.epoch=?3
      AND alias.provider_item_id=wanted.value
    LEFT JOIN journal_items turn ON turn.session_id=?2 AND turn.epoch=?3
      AND turn.item_id=COALESCE(alias.item_id,wanted.value)`)
      .all(JSON.stringify(turns), target.sessionId, target.epoch)
      .map((row) => [String(row.turn_item_id), row.state])
  )
}

export function journalDomainDisplayTurnState(
  item: AgentJournalRenderItem,
  states: ReadonlyMap<string, unknown>
): unknown {
  return item.turnScope?.kind === 'turn' ? states.get(item.turnScope.turnItemId) : undefined
}

export function readJournalDomainDisplayedRow(
  db: Database.Database,
  target: JournalDomainItemTarget,
  row: SqliteRow
): { item: AgentJournalRenderItem; payload: string } {
  const source: AgentJournalRenderItem = JSON.parse(String(row.payload_json))
  const states = readJournalDomainStopStates(db, target, [String(row.item_id)])
  const item = resolveJournalDomainDisplay(
    source,
    row.wire_version,
    row.wire_json,
    journalDomainDisplayTurnState(source, states)
  )
  return { item, payload: item === source ? String(row.payload_json) : JSON.stringify(item) }
}
