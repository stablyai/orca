import type { JournalHostDatabase } from './journal-host-database'
import { readJournalSessionEpoch } from './journal-row-table'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { journalOutcomeSource, type JournalOutcomeSource } from './journal-outcome-format'
import { JournalOutcomeFold } from './journal-outcome-codec'
import { readJournalOutcomePage, JOURNAL_OUTCOME_START } from './journal-outcome-table'
import { writeJournalOutcomeCache } from './journal-outcome-cache'
import type { JournalCatchUpStep, JournalCatchUpPacing } from './journal-projection-catch-up'

export class JournalOutcomeRebuild {
  private after = JOURNAL_OUTCOME_START
  private clearing = true
  private started = false
  private needsDecode = false
  private state: JournalReducerState | null = null
  private fold = new JournalOutcomeFold()
  private disposed = false
  private throughSequence = 0

  constructor(
    private readonly database: JournalHostDatabase,
    readonly sessionId: string,
    readonly epoch: string,
    private source: JournalOutcomeSource
  ) {}

  get through(): number {
    return this.throughSequence
  }

  async load(pacing: JournalCatchUpPacing): Promise<'ready' | 'stopped'> {
    if (!this.needsDecode) {
      return 'ready'
    }
    const pages = this.fold.finishPages(this.sessionId, this.epoch, this.source.through)
    let step = pacing.work(() => pages.next())
    while (!step.done) {
      if (
        !(await pacing.rest()) ||
        this.disposed ||
        readJournalSessionEpoch(this.database.db, this.sessionId) !== this.epoch
      ) {
        return 'stopped'
      }
      step = pacing.work(() => pages.next())
    }
    if (this.disposed) {
      return 'stopped'
    }
    this.state = step.value
    this.needsDecode = false
    return 'ready'
  }

  page(): JournalCatchUpStep {
    const { database, sessionId, epoch } = this
    const result = database.transaction((db) => {
      const source = journalOutcomeSource(db, sessionId, epoch)
      if (this.disposed || !source || source.generation !== this.source.generation) {
        return 'retired'
      }
      if (!this.started) {
        db.prepare('DELETE FROM journal_cache_stamp WHERE session_id = ?').run(sessionId)
        db.prepare('DELETE FROM journal_state WHERE session_id = ?').run(sessionId)
        this.started = true
      }
      if (this.clearing) {
        for (const table of ['journal_items', 'journal_entries']) {
          const result = db
            .prepare(`DELETE FROM ${table} WHERE rowid IN (
            SELECT rowid FROM ${table} WHERE session_id = ? LIMIT 32)`)
            .run(sessionId)
          if (result.changes > 0) {
            return 'advanced'
          }
        }
        this.clearing = false
      }
      const values = readJournalOutcomePage(
        db,
        sessionId,
        epoch,
        source.generation,
        this.after,
        this.source.through
      )
      const last = values.at(-1)
      if (last) {
        const identity = createJournalReducerState(sessionId, epoch)
        writeJournalOutcomeCache(db, identity, source.generation, values, false)
        return { values, after: { seq: last.seq, field: last.field, key: last.key } }
      }
      if (source.through > this.source.through) {
        this.source = source
        this.state = null
        return 'advanced'
      }
      if (!this.state) {
        this.needsDecode = true
        return 'advanced'
      }
      writeJournalOutcomeCache(db, this.state, source.generation, [])
      return 'current'
    })
    if (typeof result === 'object') {
      for (const value of result.values) {
        this.fold.add(value)
      }
      this.after = result.after
      return 'advanced'
    }
    if (result === 'current') {
      this.throughSequence = this.source.through
    }
    return result
  }

  close(): void {
    this.disposed = true
    this.state = null
    this.fold = new JournalOutcomeFold()
  }
}
