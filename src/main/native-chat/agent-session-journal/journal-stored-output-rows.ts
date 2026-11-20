import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { JOURNAL_DOMAIN_ITEM_COLUMNS } from './journal-domain-item-read-columns'
import type { ItemsByKindRowRead } from './journal-items-by-kind-page'
import {
  hasJournalStoredOutput,
  hydrateJournalItemOutput,
  journalItemOutputPreview,
  journalStoredTextBytes,
  JOURNAL_STORED_OUTPUT_WRITES,
  storeJournalItemOutput
} from './journal-stored-output'
import { hydrateJournalTextTail } from './journal-text-tail'

type Prefix = readonly [sessionId: string, epoch: string]

const WIRE_BYTES = JOURNAL_DOMAIN_ITEM_COLUMNS.indexOf('wire_bytes')

/** The one parse of a journal_items item column. */
export function readJournalStoredItem<T extends AgentJournalRenderItem = AgentJournalRenderItem>(
  db: Database.Database,
  prefix: Prefix,
  json: unknown,
  /** The row's `output_blob` when the read already selected it, saving a lookup per row. */
  blob?: unknown
): T {
  const item: T = JSON.parse(String(json))
  return hydrateJournalStoredItem(db, prefix, item, blob)
}

/** A row that selected `payload_json` and, to save a lookup, `output_blob`. */
export function readJournalStoredRow(
  db: Database.Database,
  prefix: Prefix,
  row: { payload_json?: unknown; output_blob?: unknown }
): AgentJournalRenderItem {
  // A row that did not select the blob reads it by key, never as missing.
  return readJournalStoredItem(db, prefix, row.payload_json, row.output_blob)
}

/** A page row's size counts its stored text, which is read only if the row joins the page. */
export function measureJournalStoredRow(
  db: Database.Database,
  prefix: Prefix,
  row: { payload_json?: unknown; output_blob?: unknown }
): ItemsByKindRowRead {
  const json = String(row.payload_json)
  if (!(row.output_blob instanceof Uint8Array)) {
    return { bytes: json.length, item: () => hydrateJournalTextTail(db, prefix, JSON.parse(json)) }
  }
  const parsed: AgentJournalRenderItem = JSON.parse(json)
  return {
    bytes: json.length + journalStoredTextBytes(parsed),
    item: () => hydrateJournalStoredItem(db, prefix, parsed, row.output_blob)
  }
}

/** Returns the same object when the item stores nothing, so callers can reuse its row text. */
export function hydrateJournalStoredItem<T extends AgentJournalRenderItem>(
  db: Database.Database,
  prefix: Prefix,
  item: T,
  blob?: unknown
): T {
  if (!hasJournalStoredOutput(item)) {
    return hydrateJournalTextTail(db, prefix, item)
  }
  const held =
    blob === undefined
      ? db
          .prepare(
            'SELECT output_blob FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?'
          )
          .get(...prefix, item.itemId)?.output_blob
      : blob
  return hydrateJournalItemOutput(item, held instanceof Uint8Array ? held : null)
}

export type JournalStoredItemRow<V> = {
  payload: string
  values: V[]
  blob: Buffer | null
  /** The row's own blob holds this item's text (an item whose stored output could not be read). */
  keep: boolean
}

/** Row values for one item write: stored text moves to the blob; client-form columns stay as computed. */
export function journalStoredItemRow<V>(
  db: Database.Database,
  prefix: Prefix,
  item: AgentJournalRenderItem,
  payload: string,
  values: readonly V[],
  writes = JOURNAL_STORED_OUTPUT_WRITES
): JournalStoredItemRow<V | number> {
  if (hasJournalStoredOutput(item)) {
    const held = db
      .prepare(`SELECT 1 FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=? AND output_blob IS NOT NULL`)
      .get(...prefix, item.itemId)
    if (held) {
      return { payload, values: [...values], blob: null, keep: true }
    }
    // A fork or copy of an output that could not be read keeps its preview rather than failing.
    console.warn(`[agent-session-journal] kept only the preview of a saved output in ${prefix[0]}`)
    return {
      payload: JSON.stringify(journalItemOutputPreview(item)),
      values: [...values],
      blob: null,
      keep: false
    }
  }
  const stored = writes ? storeJournalItemOutput(item) : null
  if (!stored) {
    return { payload, values: [...values], blob: null, keep: false }
  }
  const next: (V | number)[] = [...values]
  // A null client size means "the stored payload's length", which the stored form no longer is.
  next[WIRE_BYTES] ??= Buffer.byteLength(payload, 'utf8')
  return { payload: JSON.stringify(stored.item), values: next, blob: stored.blob, keep: false }
}
