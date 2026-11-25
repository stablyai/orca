import { createHash } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalDomainItemWire } from './journal-domain-item-wire'
import { journalDomainOutlineSource } from './journal-domain-outline-source'
import { runJournalTransaction } from './database/journal-database'
import { JOURNAL_TEXT_TAIL_WRITES } from './journal-text-tail-writes'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'

type Prefix = readonly [sessionId: string, epoch: string]
type TailText = AgentJournalMessageItem & { blocks: [{ type: 'text'; text: string }] }

// A store this build opened read-only (a newer schema) may predate the table; it holds no tail.
// Only presence is remembered: a reader that looked before the writer created it looks again.
const tailTables = new WeakSet<Database.Database>()

function hasTailTable(db: Database.Database): boolean {
  if (tailTables.has(db)) {
    return true
  }
  const present =
    db
      .prepare(
        `SELECT 1 AS present FROM sqlite_schema WHERE type='table' AND name='journal_text_tail'`
      )
      .get() !== undefined
  if (present) {
    tailTables.add(db)
  }
  return present
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
  // Probed per read: another build sharing the store may append at any time.
  return isTailText(item.body) && hasTailTable(db) ? joinTail(db, prefix, item, item.body) : item
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
  return {
    ...item,
    revision: tail.at(-1)!.seq,
    body: { ...body, blocks: [{ ...body.blocks[0], text }] }
  }
}

/** Everything but the text and revision, which a save may not change while it appends. */
function tailSkeleton(item: AgentJournalRenderItem, block: { text: string }): string {
  return JSON.stringify(item, function (this: unknown, key, value: unknown) {
    return (this === item && key === 'revision') || (this === block && key === 'text')
      ? undefined
      : value
  })
}

function textHash(text: string): string {
  // UTF-16 code units, so a lone surrogate never hashes like U+FFFD.
  return createHash('sha256').update(text, 'utf16le').digest('base64')
}

type SavedText = { chars: number; foldedChars: number; hash: string; skeleton: string }

/** The newest tail row states what is saved; only the first append after a fold reads the payload. */
function readSavedText(
  db: Database.Database,
  prefix: Prefix,
  itemId: string
): SavedText | undefined {
  const last = db
    .prepare(`SELECT saved_chars,folded_chars,saved_hash,skeleton FROM journal_text_tail
      WHERE session_id=? AND epoch=? AND item_id=? ORDER BY seq DESC LIMIT 1`)
    .get(...prefix, itemId)
  if (last) {
    return {
      chars: Number(last.saved_chars),
      foldedChars: Number(last.folded_chars),
      hash: String(last.saved_hash),
      skeleton: String(last.skeleton)
    }
  }
  const stored = db
    .prepare(`SELECT json_remove(payload_json,'$.revision','$.body.blocks[0].text') AS skeleton,
      json_extract(payload_json,'$.body.blocks[0].text') AS folded
      FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(...prefix, itemId)
  // SQLite reads a stored lone surrogate back as U+FFFD, which is not the saved text.
  if (
    !stored ||
    typeof stored.folded !== 'string' ||
    typeof stored.skeleton !== 'string' ||
    stored.folded.includes('\uFFFD')
  ) {
    return undefined
  }
  return {
    chars: stored.folded.length,
    foldedChars: stored.folded.length,
    hash: textHash(stored.folded),
    skeleton: stored.skeleton
  }
}

/**
 * Saves only the text added since the last save. False sends the caller to the full rewrite,
 * which folds the tail: any change but appended text, derived columns that would move, a page-
 * sized message, or a tail as large as the folded text (so total writes stay linear). Each save
 * reads only the newest tail row, so its cost does not grow with the saves before it.
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
  const columns = db
    .prepare(`SELECT wire_version,wire_json IS NULL AND detail_json IS NULL AS plain,
      outline_source_json FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?`)
    .get(...prefix, item.itemId)
  if (!columns?.plain || !block.text.isWellFormed()) {
    return false
  }
  const saved = readSavedText(db, prefix, item.itemId)
  const skeleton = tailSkeleton(item, block)
  if (
    !saved ||
    skeleton !== saved.skeleton ||
    block.text.length < saved.chars ||
    block.text.length - saved.foldedChars >= saved.foldedChars ||
    textHash(block.text.slice(0, saved.chars)) !== saved.hash
  ) {
    return false
  }
  const payload = JSON.stringify(item)
  const wire = journalDomainItemWire(item, payload)
  const outline: { item?: { revision?: number } } | null =
    typeof columns.outline_source_json === 'string' ? JSON.parse(columns.outline_source_json) : null
  if (
    wire.wireJson !== null ||
    wire.detailJson !== null ||
    wire.wireVersion !== columns.wire_version ||
    // The outline never reads the revision it embeds, so the folded one stands until the fold.
    journalDomainOutlineSource({ ...item, revision: outline?.item?.revision ?? item.revision }) !==
      columns.outline_source_json
  ) {
    return false
  }
  db.prepare(`INSERT INTO journal_text_tail(session_id,epoch,item_id,seq,text,saved_chars,folded_chars,
    saved_hash,skeleton,turn_item_id) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    ...prefix,
    item.itemId,
    item.revision,
    block.text.slice(saved.chars),
    block.text.length,
    saved.foldedChars,
    textHash(block.text),
    skeleton,
    item.turnScope?.kind === 'turn' ? item.turnScope.turnItemId : null
  )
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

/** The finished turn's own items with a tail, through the tail table's turn index. */
function turnTailItems(
  db: Database.Database,
  turn: { sessionId: string; epoch: string; turnItemId: string }
): Record<string, unknown>[] {
  return db
    .prepare(`SELECT DISTINCT session_id,epoch,item_id FROM journal_text_tail
      INDEXED BY journal_text_tail_turn WHERE session_id=? AND epoch=? AND turn_item_id=?`)
    .all(turn.sessionId, turn.epoch, turn.turnItemId)
}

/** Folds every tail in the store, or only those of one finished turn's items. */
function foldJournalTextTails(
  db: Database.Database,
  turn?: { sessionId: string; epoch: string; turnItemId: string }
): void {
  const items = (
    turn
      ? turnTailItems(db, turn)
      : db.prepare('SELECT DISTINCT session_id,epoch,item_id FROM journal_text_tail').all()
  ).map((row) => ({
    prefix: [String(row.session_id), String(row.epoch)] as const,
    itemId: String(row.item_id)
  }))
  for (const { prefix, itemId } of items) {
    const stored = db
      .prepare(
        'SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?'
      )
      .get(...prefix, itemId)
    const item: AgentJournalRenderItem | undefined = stored
      ? JSON.parse(String(stored.payload_json))
      : undefined
    if (item && isTailText(item.body)) {
      const target = { sessionId: prefix[0], epoch: prefix[1] }
      writeJournalTextPayload(db, target, joinTail(db, prefix, item, item.body))
    } else {
      db.prepare('DELETE FROM journal_text_tail WHERE session_id=? AND epoch=? AND item_id=?').run(
        ...prefix,
        itemId
      )
    }
  }
}

/** A finished turn's own streams are done, including those that ended without a last save.
 *  Thread-scoped streams that outlive the turn keep their tail. */
export function foldJournalTurnTextTails(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  item: AgentJournalRenderItem,
  previous: AgentJournalRenderItem | undefined
): void {
  // Only when the turn ends: later rewrites of a finished turn row must not fold again.
  const ended = (body: AgentJournalRenderItem['body'] | undefined) =>
    (readAgentJournalTurn(body)?.state ?? 'running') !== 'running'
  if (ended(item.body) && !(previous && ended(previous.body))) {
    foldJournalTextTails(db, { ...target, turnItemId: item.itemId })
  }
}

/** At store open, before any chat opens, and on clean quit; a failed fold leaves the tail to read. */
export function tryFoldJournalTextTails(db: Database.Database): void {
  try {
    runJournalTransaction(db, () => foldJournalTextTails(db))
  } catch (error) {
    console.warn('[agent-session-journal] left streamed text tails to fold later', error)
  }
}
