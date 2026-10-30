import type { JournalHostDatabase } from './journal-host-database'
import { journalOutcomeSource, type JournalOutcomeSource } from './journal-outcome-format'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import { readJournalOutcomePage, JOURNAL_OUTCOME_START } from './journal-outcome-table'
import { journalCacheMatches, writeJournalOutcomeCacheRows } from './journal-outcome-cache'
import { writeJournalProjectionScalars } from './journal-projection-table'
import { outcomeFormat1Scalars } from './journal-outcome-format-1'
import type { JournalCatchUpStep } from './journal-projection-catch-up'

/** Copies outcomes into the cache in log order, each page its own transaction. It keeps reading to
 * the moving tip, so appends during a rebuild cost only their own outcomes, and it stamps the cache
 * from the scalar outcomes, never decoding the whole chat. */
export class JournalOutcomeRebuild {
  private after = JOURNAL_OUTCOME_START
  private clearing = true
  private started = false
  private disposed = false
  private readonly scalars = new Map<string, string>()
  private throughSequence = 0

  constructor(
    private readonly database: JournalHostDatabase,
    readonly sessionId: string,
    readonly epoch: string,
    private readonly source: JournalOutcomeSource
  ) {}

  get through(): number {
    return this.throughSequence
  }

  page(): JournalCatchUpStep {
    const { database, sessionId, epoch } = this
    const result = database.transaction((db): JournalCatchUpStep | number => {
      const source = journalOutcomeSource(db, sessionId, epoch)
      if (this.disposed || !source || source.generation !== this.source.generation) {
        return 'retired'
      }
      if (!this.started) {
        if (journalCacheMatches(db, sessionId, epoch, source)) {
          return source.through
        }
        // Unstamped first; the row stays as the session's anchor for the sweep while rows change.
        writeJournalProjectionScalars(db, {
          sessionId,
          epoch,
          generation: 0,
          through: 0,
          stateJson: '{}'
        })
        this.started = true
      }
      if (this.clearing) {
        for (const table of ['journal_items', 'journal_entries']) {
          const cleared = db
            .prepare(`DELETE FROM ${table} WHERE rowid IN (
            SELECT rowid FROM ${table} WHERE session_id = ? LIMIT 32)`)
            .run(sessionId)
          if (cleared.changes > 0) {
            return 'advanced'
          }
        }
        this.clearing = false
      }
      const values = readJournalOutcomePage(db, source.generation, this.after, source.through)
      const last = values.at(-1)
      if (last) {
        writeJournalOutcomeCacheRows(db, sessionId, epoch, values)
        for (const value of values) {
          if (value.field === '$') {
            this.scalars.set(value.key, value.json)
          }
        }
        this.after = { seq: last.seq, field: last.field, key: last.key }
        return 'advanced'
      }
      const scalars = outcomeFormat1Scalars.safeParse(
        Object.fromEntries(
          [...this.scalars].map(([key, json]) => [JSON.parse(key), JSON.parse(json)])
        )
      )
      if (!scalars.success || scalars.data.lastSequence !== source.through) {
        throw new JournalOutcomeDecodeError('invalid journal outcome coverage')
      }
      const stateJson = JSON.stringify(scalars.data)
      writeJournalProjectionScalars(db, {
        sessionId,
        epoch,
        generation: source.generation,
        through: source.through,
        stateJson
      })
      return source.through
    })
    if (typeof result === 'number') {
      this.throughSequence = result
      return 'current'
    }
    return result
  }

  close(): void {
    this.disposed = true
    this.scalars.clear()
  }
}
