import type Database from '../../sqlite/sync-database'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'
import {
  agentJournalItemForWire,
  rememberAgentJournalItemWireForm
} from '../agent-session-wire/publication/history/agent-session-item-wire-form'
import type { HistoryItemForm } from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { journalDomainItemWire } from './journal-domain-item-wire'
import {
  journalDomainDisplayTurnState,
  readJournalDomainStopStates,
  resolveJournalDomainDisplay,
  type JournalDomainItemTarget
} from './journal-domain-item-display'

export function journalDomainClientFormColumns(alias = 'item'): string {
  return `${alias}.item_id,${alias}.wire_version,
    CASE WHEN ${alias}.wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION}
      THEN COALESCE(${alias}.wire_json,${alias}.payload_json) ELSE ${alias}.payload_json END AS client_json,
    CASE WHEN ${alias}.wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION}
      THEN COALESCE(${alias}.wire_bytes,octet_length(${alias}.payload_json)) END AS client_bytes`
}

/** Decode only this selected set; callers retain admitted forms and discard a rejected whole group. */
export function readJournalDomainClientForms(
  db: Database.Database,
  target: JournalDomainItemTarget,
  ids: readonly string[],
  forms = new Map<string, HistoryItemForm>(),
  states?: ReadonlyMap<string, unknown>
): Map<string, HistoryItemForm> {
  const wanted = [...new Set(ids)].filter((id) => !forms.has(id))
  if (wanted.length === 0) {
    return forms
  }
  states ??= readJournalDomainStopStates(db, target, wanted)
  for (const row of db
    .prepare(`SELECT ${journalDomainClientFormColumns()} FROM json_each(?) wanted
    CROSS JOIN journal_items item
    WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value AND item.hidden=0`)
    .iterate(JSON.stringify(wanted), target.sessionId, target.epoch)) {
    forms.set(String(row.item_id), readJournalDomainClientForm(row, states))
  }
  return forms
}

export function readJournalDomainClientForm(
  row: SqliteRow,
  states: ReadonlyMap<string, unknown>
): HistoryItemForm {
  const item: AgentJournalRenderItem = JSON.parse(String(row.client_json))
  return row.wire_version === AGENT_SESSION_ITEM_WIRE_VERSION
    ? rememberAgentJournalItemWireForm(item, Number(row.client_bytes))
    : agentJournalItemForWire(
        resolveJournalDomainDisplay(
          item,
          row.wire_version,
          null,
          journalDomainDisplayTurnState(item, states)
        )
      )
}

export function readJournalDomainClientItems(
  db: Database.Database,
  target: JournalDomainItemTarget,
  ids: readonly string[],
  forms?: Map<string, HistoryItemForm>
): AgentJournalRenderItem[] {
  const selected = readJournalDomainClientForms(db, target, ids, forms)
  return ids.flatMap((id) => (selected.has(id) ? [selected.get(id)!.item] : []))
}

export function readJournalDomainItemDetail(
  db: Database.Database,
  target: JournalDomainItemTarget,
  itemId: string
): AgentJournalRenderItem | null {
  const row = db
    .prepare(`SELECT wire_version,
    CASE WHEN wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION} THEN COALESCE(detail_json,payload_json)
      ELSE payload_json END AS detail_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
    .get(target.sessionId, target.epoch, itemId)
  if (!row) {
    return null
  }
  const item: AgentJournalRenderItem = JSON.parse(String(row.detail_json))
  if (row.wire_version === AGENT_SESSION_ITEM_WIRE_VERSION) {
    return item
  }
  const states = readJournalDomainStopStates(db, target, [itemId])
  const displayed = resolveJournalDomainDisplay(
    item,
    row.wire_version,
    null,
    journalDomainDisplayTurnState(item, states)
  )
  const wire = journalDomainItemWire(item, String(row.detail_json), displayed)
  return wire.detailJson === null ? displayed : JSON.parse(wire.detailJson)
}
