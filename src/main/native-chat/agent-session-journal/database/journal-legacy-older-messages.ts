import type Database from '../../../sqlite/sync-database'
import type { RestoredJournalDomainImport } from '../journal-domain-import'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  addedBesideHeld,
  heldItem,
  heldTextHere,
  isHeldShape,
  isObject,
  isRealMessage,
  parseJson
} from './journal-legacy-message-compare'

/**
 * Where this file last read an original chat: past it, every write is the older Orca's own. From a
 * saved revision the original's own sequence numbers say so exactly; items saved as outcome
 * records carry the same sequence. Files copied before revisions were kept have none: a converted
 * chat then compares against what it holds here, and any other against when the original was
 * last read, by the time each item was saved.
 */
export type OlderMessageCursor =
  | {
      kind: 'revision'
      epoch: string
      tip: number
      generation: number | null
      through: number
      heldEpoch?: string
    }
  | { kind: 'held'; epoch: string }
  | { kind: 'time'; after: number }

export function olderMessageCursor(
  revision: string | undefined,
  heldEpoch: string | null,
  lastRead: number | null
): OlderMessageCursor | null {
  const saved = parseRevision(revision)
  if (saved?.kind === 'revision' && heldEpoch !== null) {
    return { ...saved, heldEpoch }
  }
  return (
    saved ??
    (heldEpoch !== null
      ? { kind: 'held', epoch: heldEpoch }
      : lastRead !== null
        ? { kind: 'time', after: lastRead }
        : null)
  )
}

/**
 * Whether the older Orca added a real user or agent message past the cursor: a send, agent output,
 * or text queued to send. Uncertain is "added", so its text is kept, never taken as shown here.
 * Bookkeeping alone (CI lines, recovery and queue marks) is not: that state becomes the baseline,
 * and those lines stay only in the original journal.
 */
export function olderOrcaAddedMessages(
  source: Database.Database,
  db: Database.Database,
  id: string,
  cursor: OlderMessageCursor,
  revision: string,
  restore: () => RestoredJournalDomainImport | null
): boolean {
  if (cursor.kind !== 'revision') {
    return addedBesideHeld(db, id, cursor, restore)
  }
  // Another outcome log, or a tip or coverage behind the revision read here, is another history
  // (a restored backup): nothing past the revision says what it holds.
  const current = parseRevision(revision)
  if (
    current?.kind === 'revision' &&
    current.epoch === cursor.epoch &&
    (current.tip < cursor.tip ||
      current.through < cursor.through ||
      (cursor.generation !== null && current.generation !== cursor.generation))
  ) {
    return true
  }
  return addedPastRevision(source, db, id, cursor)
}

/** One chat's original as last read here: what any record past `past` is compared with. */
type Past = {
  source: Database.Database
  db: Database.Database
  id: string
  epoch: string
  past: number
  generation?: number
  prefix?: number
  heldEpoch?: string
  frozen?: { sends: Map<string, string>; cards: Map<string, string> }
}

/**
 * Reads only what the original saved past the revision, row by row: an input row, or an outcome
 * record of an item or a queued card. A sent message's own item is how a send counts here.
 */
function addedPastRevision(
  source: Database.Database,
  db: Database.Database,
  id: string,
  cursor: Extract<OlderMessageCursor, { kind: 'revision' }>
): boolean {
  const session = source.prepare('SELECT epoch FROM journal_sessions WHERE session_id=?').get(id)
  if (!session) {
    return false
  }
  const epoch = String(session.epoch)
  // A re-founded epoch starts its sequence over: everything in it is new.
  const at: Past = {
    source,
    db,
    id,
    epoch,
    past: epoch === cursor.epoch ? cursor.through : -1,
    heldEpoch: cursor.heldEpoch
  }
  for (const { row_json: row } of source
    .prepare(
      'SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq>? ORDER BY seq'
    )
    .iterate(id, epoch, at.past)) {
    if (rowAddsMessage(at, parseJson(row))) {
      return true
    }
  }
  const outcomes = source
    .prepare(
      'SELECT generation, prefix_seq AS prefix FROM journal_outcome_epochs WHERE session_id=? AND epoch=?'
    )
    .get(id, epoch)
  if (!outcomes) {
    return false
  }
  at.generation = Number(outcomes.generation)
  at.prefix = Number(outcomes.prefix)
  // Each key once, as it stands now: text queued there and then withdrawn adds nothing.
  for (const { field, value_json: value } of source
    .prepare(`SELECT field, value_json FROM journal_outcomes AS o WHERE generation=?1 AND seq>?2
      AND deleted=0 AND field IN ('items','queue.cards') AND seq=(SELECT MAX(seq)
        FROM journal_outcomes WHERE generation=?1 AND field=o.field AND entry_key=o.entry_key)
      ORDER BY seq`)
    .iterate(outcomes.generation, at.past)) {
    const parsed = parseJson(value)
    // A card is stored keyed, as `[messageId, card]`.
    if (
      field === 'items'
        ? itemIsNew(at, parsed)
        : cardIsNew(at, Array.isArray(parsed) ? parsed[1] : undefined)
    ) {
      return true
    }
  }
  return false
}

function rowAddsMessage(at: Past, row: unknown): boolean {
  if (!isObject(row) || row.recovered === true) {
    return false
  }
  const held = (item: unknown): boolean =>
    at.heldEpoch !== undefined &&
    isHeldShape(item) &&
    heldItem(at.db, at.id, at.heldEpoch, item, 'or-later')
  switch (row.kind) {
    case 'submission':
      return true
    case 'item':
      return isRealMessage(row) && !held(row)
    case 'lifecycle-batch':
      return (
        Array.isArray(row.mutations) &&
        row.mutations.some((mutation) => isRealMessage(mutation) && !held(mutation))
      )
    case 'queue':
      // Typed or edited text to send. A card coming back after a failed send, or a send an open
      // set back as unsent with its own text, was there before.
      return (
        isObject(row.change) &&
        typeof row.messageId === 'string' &&
        (row.change.op === 'edited' ||
          (row.change.op === 'queued' &&
            row.change.returned === undefined &&
            row.change.recovers === undefined)) &&
        !(
          at.heldEpoch !== undefined &&
          heldTextHere(at.db, at.id, at.heldEpoch, row.messageId, row.change.body)
        )
      )
    default:
      return false
  }
}

/**
 * An outcome record rewrites a whole item, so one past the revision can be a message already there
 * that an open moved: a send it set back as unsent keeps its id, text and revision. Whatever can't
 * be shown to hold the same text as before is new, so it is kept. A converted chat compares with
 * what it holds here; any other with the original's own earlier text.
 */
function itemIsNew(at: Past, item: unknown): boolean {
  if (!isRealMessage(item) || !isHeldShape(item)) {
    return false
  }
  return at.heldEpoch === undefined
    ? earlierItemText(at, item.itemId) !== JSON.stringify(item.body)
    : !heldItem(at.db, at.id, at.heldEpoch, item, 'or-later')
}

/**
 * Text queued or edited past the revision. An open sets an unsent send back as a card under the
 * send's own id: with the send's own text, that text was already there.
 */
function cardIsNew(at: Past, card: unknown): boolean {
  if (
    !isObject(card) ||
    (card.state !== 'waiting' && card.state !== 'returned') ||
    typeof card.messageId !== 'string'
  ) {
    return false
  }
  return at.heldEpoch === undefined
    ? earlierCardText(at, card.messageId) !== JSON.stringify(card.body)
    : !heldTextHere(at.db, at.id, at.heldEpoch, card.messageId, card.body)
}

/** An item's text at or before the revision: its outcome record, or the send it presents. */
function earlierItemText(at: Past, itemId: string): string | undefined {
  const prior = priorRecord(at, 'items', itemId)
  if (isObject(prior)) {
    return JSON.stringify(prior.body)
  }
  const identity = parseAgentJournalItemKey(itemId)
  return identity?.provider === 'orca' && 'clientMessageId' in identity
    ? frozenText(at).sends.get(identity.clientMessageId)
    : undefined
}

/** A card's text at or before the revision, or the text of the send it was set back from. */
function earlierCardText(at: Past, messageId: string): string | undefined {
  const prior = priorRecord(at, 'queue.cards', messageId)
  if (Array.isArray(prior) && isObject(prior[1])) {
    return JSON.stringify(prior[1].body)
  }
  return (
    frozenText(at).cards.get(messageId) ?? earlierItemText(at, agentJournalSubmissionKey(messageId))
  )
}

/** The newest outcome record for a key at or before the revision. */
function priorRecord(at: Past, field: string, key: string): unknown {
  const row = at.source
    .prepare(`SELECT value_json FROM journal_outcomes WHERE generation=? AND field=?
      AND entry_key=? AND seq<=? ORDER BY seq DESC LIMIT 1`)
    .get(at.generation ?? null, field, JSON.stringify(key), at.past)
  return row === undefined ? undefined : parseJson(row.value_json)
}

/**
 * Sends' and cards' text in the frozen input rows before the outcome log, read once per chat and
 * only when a record would otherwise count.
 */
function frozenText(at: Past): NonNullable<Past['frozen']> {
  if (!at.frozen) {
    const frozen = { sends: new Map<string, string>(), cards: new Map<string, string>() }
    for (const { row_json: text } of at.source
      .prepare(`SELECT row_json FROM journal_rows WHERE session_id=? AND epoch=? AND seq<=?
        AND (instr(row_json,'"kind":"submission"')>0 OR instr(row_json,'"kind":"queue"')>0)
        ORDER BY seq`)
      .iterate(at.id, at.epoch, Math.min(at.past, at.prefix ?? at.past))) {
      const row = parseJson(text)
      if (!isObject(row)) {
        continue
      }
      if (row.kind === 'submission' && typeof row.clientMessageId === 'string') {
        frozen.sends.set(row.clientMessageId, JSON.stringify(row.body))
      } else if (
        row.kind === 'queue' &&
        typeof row.messageId === 'string' &&
        isObject(row.change) &&
        row.change.body !== undefined
      ) {
        frozen.cards.set(row.messageId, JSON.stringify(row.change.body))
      }
    }
    at.frozen = frozen
  }
  return at.frozen
}

/** A revision is `[epoch, input tip, outcome generation, outcome coverage]`; `null` had no history. */
function parseRevision(revision: string | undefined): OlderMessageCursor | null {
  if (revision === undefined) {
    return null
  }
  if (revision === 'null') {
    return { kind: 'revision', epoch: '', tip: 0, generation: null, through: 0 }
  }
  try {
    const parsed: unknown = JSON.parse(revision)
    if (!Array.isArray(parsed)) {
      return null
    }
    const [epoch, tip, generation, through] = parsed
    return typeof epoch === 'string' && typeof tip === 'number'
      ? {
          kind: 'revision',
          epoch,
          tip,
          generation: typeof generation === 'number' ? generation : null,
          through: Math.max(tip, typeof through === 'number' ? through : 0)
        }
      : null
  } catch {
    return null
  }
}
