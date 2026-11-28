import type Database from '../../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import {
  CLAUDE_REFUSAL_NOTICE_PREFIX,
  CLAUDE_REFUSAL_NOTICE_TIMED
} from '../../../../shared/agent-session/journal/claude-refusal-notice-family'
import { runJournalTransaction } from './journal-database'

/** The encoded id prefix of every saved Claude permission row. */
export const JOURNAL_CLAUDE_REFUSAL_PREFIX = agentJournalItemKey({
  provider: 'orca',
  clientMessageId: CLAUDE_REFUSAL_NOTICE_PREFIX
})
if (!/^[A-Za-z0-9:%-]+$/.test(JOURNAL_CLAUDE_REFUSAL_PREFIX)) {
  throw new Error('saved permission row ids must stay SQL literal text')
}

// SQLite proves a partial index usable only from its own literal terms, so ids are literals here.
// `\uffff` sorts after every encoded id.
const END = `item_id<'${JOURNAL_CLAUDE_REFUSAL_PREFIX}\uffff'`

/** Visible saved Claude permission rows. */
export const JOURNAL_CLAUDE_REFUSAL_ROWS = `hidden=0 AND item_id>='${JOURNAL_CLAUDE_REFUSAL_PREFIX}' AND ${END}`
/** The visible ones whose ids lead with their mint time. */
export const JOURNAL_CLAUDE_REFUSAL_TIMED_ROWS = `hidden=0 AND item_id>='${JOURNAL_CLAUDE_REFUSAL_PREFIX}${CLAUDE_REFUSAL_NOTICE_TIMED}' AND ${END}`

export const JOURNAL_CLAUDE_REFUSAL_POSITION_INDEX = 'journal_items_claude_refusal_position'
export const JOURNAL_CLAUDE_REFUSAL_TIMED_INDEX = 'journal_items_claude_refusal_timed_id'

// SQLite stores an index's SQL as `CREATE INDEX` and the text from its name on.
const DEFINITIONS = new Map([
  [
    JOURNAL_CLAUDE_REFUSAL_POSITION_INDEX,
    `${JOURNAL_CLAUDE_REFUSAL_POSITION_INDEX}
  ON journal_items(session_id,epoch,sequence,sequence_index,ordinal)
  WHERE ${JOURNAL_CLAUDE_REFUSAL_ROWS}`
  ],
  [
    JOURNAL_CLAUDE_REFUSAL_TIMED_INDEX,
    `${JOURNAL_CLAUDE_REFUSAL_TIMED_INDEX}
  ON journal_items(session_id,epoch,item_id)
  WHERE ${JOURNAL_CLAUDE_REFUSAL_TIMED_ROWS}`
  ]
])

/** Whether both exist. SQLite resolves names without ASCII case, so any object it would take for
 *  either name must be exactly that index; anything else is an error, never kept or used. */
function journalClaudeRefusalIndexesPresent(db: Database.Database): boolean {
  const stored = db
    .prepare(`SELECT type,name,sql FROM sqlite_schema WHERE lower(name) IN (?,?)`)
    .all(...DEFINITIONS.keys())
  for (const { type, name, sql } of stored) {
    const definition = DEFINITIONS.get(String(name))
    if (type !== 'index' || definition === undefined || sql !== `CREATE INDEX ${definition}`) {
      throw new Error(`journal index ${String(name)} has another definition`)
    }
  }
  return stored.length === DEFINITIONS.size
}

/** Added without a user_version change, so older builds still write the journal and SQLite keeps
 *  both current for them. Built together; a journal that has both takes no write lock. */
export function ensureJournalClaudeRefusalIndexes(db: Database.Database): void {
  if (journalClaudeRefusalIndexesPresent(db)) {
    return
  }
  runJournalTransaction(db, (writer) => {
    for (const definition of DEFINITIONS.values()) {
      writer.exec(`CREATE INDEX IF NOT EXISTS ${definition}`)
    }
    if (!journalClaudeRefusalIndexesPresent(writer)) {
      throw new Error('journal saved permission row indexes were not built')
    }
  })
}

/** Newest is the last appended row: journal position, never id order, which a clock moved back
 *  can invert. The greatest visible timed id floors ids minted next. Each seeks its own index, so
 *  a missing one fails the read instead of walking rows. */
export function readJournalClaudeRefusalHead(
  db: Database.Database,
  prefix: readonly [sessionId: string, epoch: string],
  family: { prefix: string; timedFrom: string }
): { itemId: string | null; greatestTimedId: string | null } {
  if (
    family.prefix !== JOURNAL_CLAUDE_REFUSAL_PREFIX ||
    family.timedFrom !== CLAUDE_REFUSAL_NOTICE_TIMED
  ) {
    throw new Error('only saved Claude permission rows have a newest-row index')
  }
  const newest = db
    .prepare(`SELECT item_id FROM journal_items INDEXED BY ${JOURNAL_CLAUDE_REFUSAL_POSITION_INDEX}
    WHERE session_id=? AND epoch=? AND ${JOURNAL_CLAUDE_REFUSAL_ROWS}
    ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
    .get(...prefix)
  const timed = db
    .prepare(`SELECT item_id FROM journal_items INDEXED BY ${JOURNAL_CLAUDE_REFUSAL_TIMED_INDEX}
    WHERE session_id=? AND epoch=? AND ${JOURNAL_CLAUDE_REFUSAL_TIMED_ROWS}
    ORDER BY item_id DESC LIMIT 1`)
    .get(...prefix)
  return {
    itemId: newest ? String(newest.item_id) : null,
    greatestTimedId: timed ? String(timed.item_id) : null
  }
}
