import type Database from '../../sqlite/sync-database'

/** One item's full place in history order; one sequence can hold several items. */
export type JournalItemPosition = { sequence: number; sequenceIndex: number; ordinal: number }

/** What `orca agent read` asks of a history frame beyond the history wire's own request. */
export type JournalAgentReadAsk = {
  /** Only items strictly older than this position, applied before count and byte admission. */
  olderThan?: JournalItemPosition
}

/** What an `agent read` cursor needs from the frame's own snapshot. */
export type JournalAgentReadExtent = {
  /** The journal's head sequence. */
  headSequence: number
  /** The highest ordinal any item of the epoch holds, hidden ones included. */
  maxOrdinal: number
  /** Each frame item's ordinal, by item ID. */
  ordinals: Record<string, number>
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
  target: { sessionId: string; epoch: string; cursor: { sequence: number } },
  ask: JournalAgentReadAsk | undefined,
  items: readonly { itemId: string }[]
): { agentRead?: JournalAgentReadExtent } {
  return ask
    ? {
        agentRead: readJournalDomainAgentReadExtent(
          db,
          target,
          items.map((item) => item.itemId)
        )
      }
    : {}
}

function readJournalDomainAgentReadExtent(
  db: Database.Database,
  target: { sessionId: string; epoch: string; cursor: { sequence: number } },
  itemIds: readonly string[]
): JournalAgentReadExtent {
  const prefix = [target.sessionId, target.epoch] as const
  const max = db
    .prepare('SELECT MAX(ordinal) AS ordinal FROM journal_items WHERE session_id=? AND epoch=?')
    .get(...prefix)
  const ordinals: Record<string, number> = {}
  for (const row of db
    .prepare(`SELECT item.item_id, item.ordinal FROM json_each(?) wanted CROSS JOIN journal_items item
      WHERE item.session_id=? AND item.epoch=? AND item.item_id=wanted.value`)
    .all(JSON.stringify(itemIds), ...prefix)) {
    ordinals[String(row.item_id)] = Number(row.ordinal)
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
