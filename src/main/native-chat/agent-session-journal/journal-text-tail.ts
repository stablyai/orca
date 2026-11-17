import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainItemWire } from './journal-domain-item-wire'
import { journalDomainOutlineSource } from './journal-domain-outline-source'
import { runJournalTransaction } from './database/journal-database'
import { JOURNAL_TEXT_TAIL_WRITES } from './journal-text-tail-writes'


type Prefix = readonly [sessionId: string, epoch: string]
type TailText = AgentJournalMessageItem & { blocks: [{ type: 'text'; text: string }] }

// With writes off, a connection that once saw no tail never sees one: only folds touch the table.
const tailsMayExist = new WeakMap<Database.Database, boolean>()

function mayHoldTails(db: Database.Database): boolean {
  if (JOURNAL_TEXT_TAIL_WRITES) {
    return true
  }
  let known = tailsMayExist.get(db)
  if (known === undefined) {
    try {
      known = db.prepare('SELECT 1 AS held FROM journal_text_tail LIMIT 1').get() !== undefined
    } catch {
      // A store opened before this build created the table holds no tail.
      known = false
    }
    tailsMayExist.set(db, known)
  }
  return known
}

/** Only a streamed single-text assistant or reasoning message can carry a tail. */
function isTailText(body: AgentJournalRenderItem['body']): body is TailText {
  if (body.kind !== 'message' || (body.role !== 'assistant' && body.role !== 'reasoning')) {
    return false
  }
  const [block] = body.blocks
  return body.blocks.length === 1 && block.type === 'text' && typeof block.text === 'string'
}

/** Rows saved after `revision`: an item at a revision already holds the text saved through it. */
function readTail(
  db: Database.Database,
  prefix: Prefix,
  itemId: string,
  revision: number
): { seq: number; text: string }[] {
  return db
    .prepare(`SELECT seq,text FROM journal_text_tail
      WHERE session_id=? AND epoch=? AND item_id=? AND seq>? ORDER BY seq`)
    .all(...prefix, itemId, revision)
    .map((row) => ({ seq: Number(row.seq), text: String(row.text) }))
}

/** The one read of a stored item's text: the folded payload plus any appended tail. */
export function hydrateJournalTextTail<T extends AgentJournalRenderItem>(
  db: Database.Database,
  prefix: Prefix,
  item: T
): T {
  return isTailText(item.body) && mayHoldTails(db) ? joinTail(db, prefix, item, item.body) : item
}

function joinTail<T extends AgentJournalRenderItem>(
  db: Database.Database,
  prefix: Prefix,
  item: T,
  body: TailText
): T {
  const tail = readTail(db, prefix, item.itemId, item.revision)
  if (tail.length === 0) {
    return item
  }
  const text = body.blocks[0].text + tail.map((row) => row.text).join('')
  // Each tail row's seq is the revision that saved it.
  return { ...item, revision: tail.at(-1)!.seq, body: { ...body, blocks: [{ ...body.blocks[0], text }] } }
}

/**
 * Saves only the text added since the last save. False sends the caller to the full rewrite,
 * which folds the tail: any change but appended text, derived columns that would move, a page-
 * sized message, or a tail as large as the folded text (so total writes stay linear).
 */
export function appendJournalTextTail(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  item: AgentJournalRenderItem
): boolean {
  if (!JOURNAL_TEXT_TAIL_WRITES || !isTailText(item.body)) {
    return false
  }
  const block = item.body.blocks[0]
  const prefix = [target.sessionId, target.epoch] as const
  const stored = db
    .prepare(`SELECT json_remove(payload_json,'$.revision','$.body.blocks[0].text') AS skeleton,
      json_extract(payload_json,'$.body.blocks[0].text') AS folded,
      wire_version,wire_json IS NULL AND detail_json IS NULL AS plain,outline_source_json
      FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(...prefix, item.itemId)
  if (!stored || !stored.plain || typeof stored.folded !== 'string') {
    return false
  }
  const skeleton = JSON.stringify(item, function (this: unknown, key, value: unknown) {
    return (this === item && key === 'revision') || (this === block && key === 'text')
      ? undefined
      : value
  })
  if (skeleton !== stored.skeleton) {
    return false
  }
  const tail = readTail(db, prefix, item.itemId, -1)
  const saved = stored.folded + tail.map((row) => row.text).join('')
  const added = block.text.slice(saved.length)
  if (
    !block.text.startsWith(saved) ||
    !added.isWellFormed() ||
    !block.text.isWellFormed() ||
    saved.length - stored.folded.length + added.length >= stored.folded.length
  ) {
    return false
  }
  const payload = JSON.stringify(item)
  const wire = journalDomainItemWire(item, payload)
  if (
    wire.wireJson !== null ||
    wire.detailJson !== null ||
    wire.wireVersion !== stored.wire_version ||
    journalDomainOutlineSource(item) !== stored.outline_source_json
  ) {
    return false
  }
  db.prepare(
    'INSERT INTO journal_text_tail(session_id,epoch,item_id,seq,text) VALUES(?,?,?,?,?)'
  ).run(...prefix, item.itemId, item.revision, added)
  // The client size is the whole text's, as the stored payload no longer is.
  db.prepare(
    'UPDATE journal_items SET revision=?,wire_bytes=? WHERE session_id=? AND epoch=? AND item_id=?'
  ).run(item.revision, Buffer.byteLength(payload, 'utf8'), ...prefix, item.itemId)
  return true
}

/** Rewrites a text item's payload and the columns derived from it; the trigger drops its tail. */
export function writeJournalTextPayload(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  item: AgentJournalRenderItem
): void {
  const payload = JSON.stringify(item)
  const { wireVersion, wireBytes, wireJson, detailJson } = journalDomainItemWire(item, payload)
  db.prepare(`UPDATE journal_items SET payload_json=?,revision=?,wire_version=?,wire_bytes=?,wire_json=?,detail_json=?,outline_source_json=?
    WHERE session_id=? AND epoch=? AND item_id=?`).run(
    payload,
    item.revision,
    wireVersion,
    wireBytes,
    wireJson,
    detailJson,
    journalDomainOutlineSource(item),
    target.sessionId,
    target.epoch,
    item.itemId
  )
}

/** Folds every tail into its payload. */
function foldJournalTextTails(db: Database.Database): number {
  const items = db
    .prepare('SELECT DISTINCT session_id,epoch,item_id FROM journal_text_tail')
    .all()
  for (const row of items) {
    const target = { sessionId: String(row.session_id), epoch: String(row.epoch) }
    const stored = db
      .prepare('SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?')
      .get(target.sessionId, target.epoch, row.item_id)
    const item: AgentJournalRenderItem | undefined = stored
      ? JSON.parse(String(stored.payload_json))
      : undefined
    const prefix = [target.sessionId, target.epoch] as const
    if (item && isTailText(item.body)) {
      writeJournalTextPayload(db, target, joinTail(db, prefix, item, item.body))
    } else {
      db.prepare(
        'DELETE FROM journal_text_tail WHERE session_id=? AND epoch=? AND item_id=?'
      ).run(...prefix, row.item_id)
    }
  }
  tailsMayExist.set(db, JOURNAL_TEXT_TAIL_WRITES)
  return items.length
}


/** At store open, before any chat opens, and on clean quit; a failed fold leaves the tail to read. */
export function tryFoldJournalTextTails(db: Database.Database): void {
  try {
    runJournalTransaction(db, () => foldJournalTextTails(db))
  } catch (error) {
    console.warn('[agent-session-journal] left streamed text tails to fold later', error)
  }
}
