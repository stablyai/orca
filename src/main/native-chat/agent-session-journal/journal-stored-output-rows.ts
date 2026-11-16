import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES } from '../agent-session-wire/publication/history/agent-session-item-wire-form'
import { utf8Head } from './item-lifecycle/journal-payload-bounds'
import { JOURNAL_DOMAIN_ITEM_COLUMNS } from './journal-domain-item-read-columns'
import {
  hasJournalStoredOutput,
  hydrateJournalItemOutput,
  JOURNAL_STORED_OUTPUT_WRITES,
  storeJournalItemOutput,
  type JournalStoredOutputForm
} from './journal-stored-output'
import { AgentSessionJournalError } from './writing/journal-write-guards'

type Prefix = readonly [sessionId: string, epoch: string]

const WIRE_BYTES = JOURNAL_DOMAIN_ITEM_COLUMNS.indexOf('wire_bytes')
const WIRE_JSON = JOURNAL_DOMAIN_ITEM_COLUMNS.indexOf('wire_json')

function readStoredOutputBlob(db: Database.Database, prefix: Prefix, itemId: string) {
  const row = db
    .prepare('SELECT output_blob FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?')
    .get(...prefix, itemId)
  return row?.output_blob instanceof Uint8Array ? row.output_blob : null
}

/** The one parse of a journal_items item column; `wire` reads at most the client head. */
export function readJournalStoredItem<T extends AgentJournalRenderItem = AgentJournalRenderItem>(
  db: Database.Database,
  prefix: Prefix,
  json: unknown,
  form: JournalStoredOutputForm = 'whole'
): T {
  return hydrateJournalStoredItem(db, prefix, JSON.parse(String(json)) as T, form)
}

export function hydrateJournalStoredItem<T extends AgentJournalRenderItem>(
  db: Database.Database,
  prefix: Prefix,
  item: T,
  form: JournalStoredOutputForm = 'whole'
): T {
  return hasJournalStoredOutput(item)
    ? hydrateJournalItemOutput(item, readStoredOutputBlob(db, prefix, item.itemId), form)
    : item
}

export type JournalStoredItemRow<V> = {
  payload: string
  values: V[]
  blob: Buffer | null
  /** The row's own blob already holds this item's text (an item whose read could not hydrate). */
  keep: boolean
}

/** The wire form shares the payload's marker only when it is exactly the stored text's head. */
function storedWireJson(
  wireJson: string,
  item: AgentJournalRenderItem,
  stored: AgentJournalRenderItem
) {
  const wire: AgentJournalRenderItem = JSON.parse(wireJson)
  const source =
    item.body.kind === 'tool-call'
      ? item.body.output
      : item.body.kind === 'diff'
        ? item.body.patch
        : undefined
  const sent =
    wire.body.kind === 'tool-call'
      ? wire.body.output
      : wire.body.kind === 'diff'
        ? wire.body.patch
        : undefined
  const marker =
    stored.body.kind === 'tool-call'
      ? stored.body.output
      : stored.body.kind === 'diff'
        ? stored.body.patch
        : undefined
  if (!source || !sent || !marker) {
    return wireJson
  }
  const fits = Buffer.byteLength(source.head, 'utf8') <= AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES
  const head = fits ? source.head : utf8Head(source.head, AGENT_SESSION_WIRE_PAYLOAD_HEAD_BYTES)
  if (sent.head !== head || sent.truncated !== (fits ? source.truncated : true)) {
    return wireJson
  }
  const body =
    wire.body.kind === 'tool-call'
      ? { ...wire.body, output: marker }
      : { ...wire.body, patch: marker }
  return JSON.stringify({ ...wire, body })
}

/** Row values for one item write: stored text moves to the blob, and its byte counts stay exact. */
export function journalStoredItemRow<V>(
  db: Database.Database,
  prefix: Prefix,
  item: AgentJournalRenderItem,
  payload: string,
  values: readonly V[],
  writes = JOURNAL_STORED_OUTPUT_WRITES
): JournalStoredItemRow<V | string | number | null> {
  if (hasJournalStoredOutput(item)) {
    if (!readStoredOutputBlob(db, prefix, item.itemId)) {
      throw new AgentSessionJournalError(
        'journal_row_rejected',
        `journal item for ${prefix[0]} names a saved output this row does not hold`
      )
    }
    return { payload, values: [...values], blob: null, keep: true }
  }
  const stored = writes ? storeJournalItemOutput(item) : null
  if (!stored) {
    return { payload, values: [...values], blob: null, keep: false }
  }
  const next = [...values]
  const wireJson = next[WIRE_JSON]
  next[WIRE_JSON] =
    typeof wireJson === 'string' ? storedWireJson(wireJson, item, stored.item) : null
  next[WIRE_BYTES] ??= Buffer.byteLength(payload, 'utf8')
  return { payload: JSON.stringify(stored.item), values: next, blob: stored.blob, keep: false }
}
