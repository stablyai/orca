import type Database from '../../sqlite/sync-database'
import { boundJournalKeyComponent } from '../../../shared/agent-session/journal/agent-session-journal-item-key'

/** One item's full place in history order; one sequence can hold several items. */
export type JournalItemPosition = { sequence: number; sequenceIndex: number; ordinal: number }

/** The snapshot an agent read cursor was issued in: its head and highest ordinal (hidden items too). */
export type JournalAgentReadIssue = { headSequence: number; maxOrdinal: number }

/** What `orca agent read` asks of a history frame beyond the history wire's own request. */
export type JournalAgentReadAsk = {
  /** Applied before count and byte admission, so a split sequence resumes inside itself. */
  olderThan?: JournalItemPosition
  since?: JournalAgentReadIssue
}

export type JournalAgentReadExtent = JournalAgentReadIssue & {
  ordinals: Record<string, number>
  /** Older history may have changed since `since`, so the cursor can't continue. */
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

/** Appends and in-place updates keep every older place; a removal (a rewind is no suffix cut),
 *  a move (a re-placed send keeps its ordinal) or a pruned event log may not. */
function changedSince(
  db: Database.Database,
  target: AgentReadHead,
  since: JournalAgentReadIssue
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
  // By the items' sequences, on the visible-position index: an oversized group's placeholders
  // carry a bounded copy of the ID.
  for (const row of db
    .prepare(`SELECT item.item_id, item.ordinal FROM json_each(?) wanted CROSS JOIN journal_items item
      WHERE item.session_id=? AND item.epoch=? AND item.hidden=0 AND item.root=1
        AND item.sequence=wanted.value`)
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
