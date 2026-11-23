import type Database from '../../sqlite/sync-database'
import { boundJournalKeyComponent } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

/** One item's full place in history order; one sequence can hold several items. */
export type JournalItemPosition = { sequence: number; sequenceIndex: number; ordinal: number }

/** What `orca agent read` asks of a history frame beyond the history wire's own request. */
export type JournalAgentReadAsk = {
  /** Only items strictly older than this position, applied before count and byte admission. */
  olderThan?: JournalItemPosition
  /** The head sequence and highest ordinal a cursor was issued at, to check against. */
  since?: { headSequence: number; maxOrdinal: number }
}

/** What an `agent read` cursor needs from the frame's own snapshot. */
export type JournalAgentReadExtent = {
  /** The journal's head sequence. */
  headSequence: number
  /** The highest ordinal any item of the epoch holds, hidden ones included. */
  maxOrdinal: number
  /** Each frame item's ordinal, by item ID. */
  ordinals: Record<string, number>
  /** With `since`: older history may have changed since then, so a cursor can't continue. */
  changedSince?: true
}

/** SQL for rows strictly older than `position`, from checked integers. */
export function journalItemsOlderThan(position: JournalItemPosition): string {
  const [sequence, index, ordinal] = [
    position.sequence,
    position.sequenceIndex,
    position.ordinal
  ].map(sqlInteger)
  return `(sequence<${sequence} OR (sequence=${sequence} AND (sequence_index<${index}
    OR (sequence_index=${index} AND ordinal<${ordinal}))))`
}

/** Sources strictly older than `position`, as `journalItemsOlderThan` bounds rows. */
export function sourcesOlderThan<T extends JournalItemPosition>(
  sources: readonly T[],
  position: JournalItemPosition
): T[] {
  return sources.filter(
    (item) =>
      (item.sequence - position.sequence ||
        item.sequenceIndex - position.sequenceIndex ||
        item.ordinal - position.ordinal) < 0
  )
}

/** The extent an agent read asked for, read in the frame's snapshot, to spread into the frame. */
export function journalAgentReadFrameFields(
  db: Database.Database,
  target: AgentReadHead,
  ask: JournalAgentReadAsk | undefined,
  items: readonly { itemId: string; sequence: number }[]
): { agentRead?: JournalAgentReadExtent } {
  return ask
    ? {
        agentRead: {
          ...readJournalDomainAgentReadExtent(db, target, items),
          ...(ask.since && changedSince(db, target, ask.since) ? { changedSince: true } : {})
        }
      }
    : {}
}

type AgentReadHead = {
  sessionId: string
  epoch: string
  cursor: { sequence: number }
  retainedSequence: number
}

/** Whether anything older could have shifted since `since`: the event log no longer reaches back
 *  to it, an event after it removed an item (a rewind is no suffix cut, so a surviving anchor
 *  proves nothing), or an item that existed then has a newer place now (a re-placed send keeps
 *  its ordinal), among the root rows an agent read pages. Appends and in-place updates keep every
 *  older place. */
function changedSince(
  db: Database.Database,
  target: AgentReadHead,
  since: NonNullable<JournalAgentReadAsk['since']>
): boolean {
  const prefix = [target.sessionId, target.epoch] as const
  return (
    target.retainedSequence > since.headSequence ||
    target.cursor.sequence < since.headSequence ||
    !!db
      .prepare(`SELECT 1 FROM journal_events WHERE session_id=? AND epoch=? AND sequence>?
        AND json_array_length(changes_json,'$.removedItemIds')>0 LIMIT 1`)
      .get(...prefix, since.headSequence) ||
    !!db
      .prepare(`SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0 AND root=1
        AND sequence>? AND ordinal<=? LIMIT 1`)
      .get(...prefix, since.headSequence, since.maxOrdinal)
  )
}

function readJournalDomainAgentReadExtent(
  db: Database.Database,
  target: AgentReadHead,
  items: readonly { itemId: string; sequence: number }[]
): JournalAgentReadExtent {
  const prefix = [target.sessionId, target.epoch] as const
  const max = db
    .prepare('SELECT MAX(ordinal) AS ordinal FROM journal_items WHERE session_id=? AND epoch=?')
    .get(...prefix)
  const ordinals: Record<string, number> = {}
  // By the items' sequences: an oversized group's placeholders carry a bounded copy of the ID.
  for (const row of db
    .prepare(`SELECT item.item_id, item.ordinal FROM json_each(?) wanted CROSS JOIN journal_items item
      WHERE item.session_id=? AND item.epoch=? AND item.sequence=wanted.value`)
    .all(JSON.stringify([...new Set(items.map((item) => item.sequence))]), ...prefix)) {
    const itemId = String(row.item_id)
    ordinals[itemId] = Number(row.ordinal)
    ordinals[boundJournalKeyComponent(itemId)] ??= Number(row.ordinal)
  }
  return {
    headSequence: target.cursor.sequence,
    maxOrdinal: max?.ordinal === null || !max ? 0 : Number(max.ordinal),
    ordinals
  }
}

function sqlInteger(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error('journal item position must be a safe integer')
  }
  return String(value)
}
