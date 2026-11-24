import { boundedStoredJson, boundedStoredJsonSql } from './journal-stored-json-bounds'
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
import { hydrateJournalStoredItem, readJournalStoredItem } from './journal-stored-output-rows'
import {
  journalDomainDisplayTurnState,
  readJournalDomainStopStates,
  resolveJournalDomainDisplay,
  type JournalDomainItemTarget
} from './journal-domain-item-display'

export function journalDomainClientFormColumns(alias = 'item'): string {
  const current = `${alias}.wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION}`
  return `${alias}.item_id,${alias}.wire_version,${boundedStoredJsonSql(
    `CASE WHEN ${current} THEN COALESCE(${alias}.wire_json,${alias}.payload_json)
      ELSE ${alias}.payload_json END`,
    'client_json',
    {
      bytes: `CASE WHEN ${current} THEN COALESCE(octet_length(${alias}.wire_json),octet_length(${alias}.payload_json))
        ELSE octet_length(${alias}.payload_json) END`,
      shortenColumn: `${alias}.payload_json`
    }
  )},
    CASE WHEN ${alias}.wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION}
      THEN COALESCE(${alias}.wire_bytes,octet_length(${alias}.payload_json)) END AS client_bytes,
    CASE WHEN ${alias}.wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION} AND ${alias}.wire_json IS NOT NULL
      THEN NULL ELSE ${alias}.output_blob END AS output_blob`
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
  const wantedJson = JSON.stringify(wanted)
  for (const row of db
    .prepare(`SELECT ${journalDomainClientFormColumns()} FROM json_each(?) wanted
    CROSS JOIN journal_items item
    WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value AND item.hidden=0`)
    .iterate(wantedJson, target.sessionId, target.epoch)) {
    if (row.wire_version !== AGENT_SESSION_ITEM_WIRE_VERSION && states === undefined) {
      states = readJournalDomainStopStates(db, target, wanted, wantedJson)
    }
    forms.set(String(row.item_id), readJournalDomainClientForm(db, target, row, states))
  }
  return forms
}

export function readJournalDomainClientForm(
  db: Database.Database,
  target: JournalDomainItemTarget,
  row: SqliteRow,
  states?: ReadonlyMap<string, unknown>
): HistoryItemForm {
  // The blob is selected only when the client form is the stored payload, never beside a saved head.
  const item = readJournalStoredItem(
    db,
    [target.sessionId, target.epoch],
    boundedStoredJson(row, 'client_json'),
    row.output_blob
  )
  return row.wire_version === AGENT_SESSION_ITEM_WIRE_VERSION
    ? rememberAgentJournalItemWireForm(item, Number(row.client_bytes))
    : agentJournalItemForWire(
        resolveJournalDomainDisplay(
          item,
          row.wire_version,
          null,
          states && journalDomainDisplayTurnState(item, states)
        )
      )
}

export function readJournalDomainClientItems(
  db: Database.Database,
  target: JournalDomainItemTarget,
  ids: readonly string[],
  forms?: Map<string, HistoryItemForm>,
  states?: ReadonlyMap<string, unknown>
): AgentJournalRenderItem[] {
  const selected = readJournalDomainClientForms(db, target, ids, forms, states)
  return ids.flatMap((id) => (selected.has(id) ? [selected.get(id)!.item] : []))
}

// Current rows keep a detail form within the detail limit; older rows hold only the whole item.
const DETAIL_JSON = `CASE WHEN wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION}
  THEN COALESCE(detail_json,payload_json) ELSE payload_json END`
const DETAIL_BYTES = `CASE WHEN wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION}
  THEN COALESCE(octet_length(detail_json),octet_length(payload_json)) ELSE octet_length(payload_json) END`

export function readJournalDomainItemDetail(
  db: Database.Database,
  target: JournalDomainItemTarget,
  itemId: string
): AgentJournalRenderItem | null {
  const row = db
    .prepare(`SELECT wire_version,${boundedStoredJsonSql(DETAIL_JSON, 'detail_json', { bytes: DETAIL_BYTES, shortenColumn: 'payload_json' })} FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
    .get(target.sessionId, target.epoch, itemId)
  if (!row) {
    return null
  }
  const parsed: AgentJournalRenderItem = JSON.parse(String(boundedStoredJson(row, 'detail_json')))
  const item = hydrateJournalStoredItem(db, [target.sessionId, target.epoch], parsed)
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
  const wire = journalDomainItemWire(
    item,
    item === parsed ? String(row.detail_json) : undefined,
    displayed
  )
  return wire.detailJson === null ? displayed : JSON.parse(wire.detailJson)
}
