import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import { AgentSessionJournalError } from './journal-write-guards'
import { journalOutcomeSource, type JournalOutcomeSource } from './journal-outcome-format'
import {
  JOURNAL_OUTCOME_FORMAT_1,
  OUTCOME_FORMAT_1_COLLECTIONS,
  outcomeFormat1StoredScalars
} from './journal-outcome-format-1'
import { JOURNAL_OUTCOME_FORMAT_2, isNativeOutcomeField } from './journal-outcome-format-2'

const PAGE_SIZE = 32
const fields = new Set<string>(OUTCOME_FORMAT_1_COLLECTIONS)
const scalars = new Set(
  Object.keys(outcomeFormat1StoredScalars.shape).map((key) => JSON.stringify(key))
)
const ordinary = (field: string, key: string): boolean =>
  field === '$' ? scalars.has(key) : fields.has(field)
const formats = new Map<number, (field: string, key: string) => boolean>([
  [JOURNAL_OUTCOME_FORMAT_1, ordinary],
  [JOURNAL_OUTCOME_FORMAT_2, (field, key) => ordinary(field, key) || isNativeOutcomeField(field)]
])
type Position = { seq: number; field: string; key: string }
type Active = JournalOutcomeSource & { sessionId: string; epoch: string; after: Position }
type Progress = {
  more: boolean
  generation: number
  active: Active | null
  done?: [number, number]
}

/** Keeps first/latest values and removal facts; newest values carry their canonical order.
 * Pass coverage is disposable: a restart rescans safely, and an unchanged chat reads no records. */
export class JournalOutcomeCompaction {
  private generation = 0
  private active: Active | null = null
  private previous = new Map<number, number>()
  private completed = new Map<number, number>()

  page(database: Pick<JournalHostDatabase, 'transaction'>): boolean {
    const progress = database.transaction((db) => this.advance(db))
    // A failed COMMIT must retry this page, not skip the records rolled back with it.
    this.generation = progress.generation
    this.active = progress.active
    if (progress.done) {
      this.completed.set(...progress.done)
    }
    if (!progress.more) {
      this.previous = this.completed
      this.completed = new Map()
    }
    return progress.more
  }

  private advance(db: Database.Database): Progress {
    if (this.active) {
      return this.compact(db, this.active)
    }
    // Page the registry too: a page never scans all chats or all retired generations.
    const row = db
      .prepare(`SELECT a.generation, e.session_id, e.epoch, e.through_seq, e.format
      FROM journal_outcome_generations a LEFT JOIN journal_outcome_epochs e
      ON e.generation = a.generation AND e.session_id = a.session_id AND e.epoch = a.epoch
      WHERE a.generation > ? ORDER BY a.generation LIMIT 1`)
      .get(this.generation)
    if (!row) {
      return { more: false, generation: 0, active: null }
    }
    const generation = Number(row.generation)
    const next: Progress = { more: true, generation, active: null }
    if (
      typeof row.session_id !== 'string' ||
      typeof row.epoch !== 'string' ||
      typeof row.through_seq !== 'number' ||
      typeof row.format !== 'number' ||
      !formats.has(row.format)
    ) {
      return next
    }
    if (this.previous.get(generation) === row.through_seq) {
      return { ...next, done: [generation, row.through_seq] }
    }
    let source: JournalOutcomeSource | null
    try {
      source = journalOutcomeSource(db, row.session_id, row.epoch)
    } catch (error) {
      if (
        error instanceof JournalOutcomeDecodeError ||
        (error instanceof AgentSessionJournalError &&
          (error.code === 'journal_read_only' || error.code === 'journal_row_rejected'))
      ) {
        // An unreadable chat must not prevent maintenance of later generations.
        return next
      }
      throw error
    }
    return {
      ...next,
      active: source && {
        ...source,
        sessionId: row.session_id,
        epoch: row.epoch,
        after: { seq: 0, field: '', key: '' }
      }
    }
  }

  private compact(db: Database.Database, active: Active): Progress {
    const next: Progress = { more: true, generation: active.generation, active: null }
    // A rewind can retire this generation during a rest; the existing retired-epoch sweep owns it.
    const source = db
      .prepare(`SELECT generation, format FROM journal_outcome_epochs
      WHERE session_id = ? AND epoch = ?`)
      .get(active.sessionId, active.epoch)
    if (
      source?.generation !== active.generation ||
      typeof source.format !== 'number' ||
      !formats.has(source.format)
    ) {
      return next
    }
    const rows = db
      .prepare(`SELECT seq, field, entry_key, format, deleted
      FROM journal_outcomes WHERE generation = ? AND (seq, field, entry_key) > (?, ?, ?)
      AND seq <= ? ORDER BY seq, field, entry_key LIMIT ${PAGE_SIZE}`)
      .all(
        active.generation,
        active.after.seq,
        active.after.field,
        active.after.key,
        active.through
      )
    const first = db.prepare(`SELECT seq FROM journal_outcomes
      WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq LIMIT 1`)
    const latest = db.prepare(`SELECT seq FROM journal_outcomes
      WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq DESC LIMIT 1`)
    const remove = db.prepare(`DELETE FROM journal_outcomes
      WHERE generation = ? AND seq = ? AND field = ? AND entry_key = ? AND format = ?`)
    let after = active.after
    for (const row of rows) {
      const admits = typeof row.format === 'number' ? formats.get(row.format) : undefined
      if (
        !admits ||
        typeof row.seq !== 'number' ||
        typeof row.field !== 'string' ||
        typeof row.entry_key !== 'string' ||
        !admits(row.field, row.entry_key)
      ) {
        // Never inspect or delete past a record whose contract this build does not know.
        return next
      }
      after = { seq: row.seq, field: row.field, key: row.entry_key }
      if (row.deleted !== 0 || row.field === 'tombstones' || row.field === 'removedTurnIds') {
        continue
      }
      const key = [active.generation, row.field, row.entry_key]
      // Declared formats store whole values per key; superseded middle values are redundant.
      // Changing that replacement meaning requires a format bump.
      if (row.seq !== first.get(...key)?.seq && row.seq !== latest.get(...key)?.seq) {
        remove.run(active.generation, row.seq, row.field, row.entry_key, row.format)
      }
    }
    return rows.length < PAGE_SIZE
      ? { ...next, done: [active.generation, active.through] }
      : { ...next, active: { ...active, after } }
  }
}
