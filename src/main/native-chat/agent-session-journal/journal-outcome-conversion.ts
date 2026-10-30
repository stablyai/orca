import { randomUUID } from 'node:crypto'
import type { JournalHostDatabase } from './journal-host-database'
import { createJournalReducerState, type JournalReducerState } from './journal-reducer'
import { parseJournalRow, type JournalRow } from './journal-row-schema'
import { readJournalRowsWithin, readJournalSessionEpoch } from './journal-row-table'
import { journalOutcomeSource, publishJournalOutcomeSource } from './journal-outcome-format'
import {
  persistJournalOutcomeRows,
  rebuildJournalOutcomePages,
  JOURNAL_OUTCOME_PAGE_BYTES,
  JOURNAL_OUTCOME_PAGE_ROWS
} from './journal-outcome-table'
import { activeJournalGenerations } from './journal-maintenance'
import {
  journalEntryJson,
  journalStateCollections,
  journalStateScalars
} from './journal-state-layout'
import type { JournalCatchUpStep, JournalCatchUpPacing } from './journal-projection-catch-up'

// Intended: private conversion state and paced publication keep bookkeeping off the send path.
export class JournalOutcomeConversion {
  private state: JournalReducerState
  private readonly generation = randomUUID()
  private started = false
  private verified = -1
  private disposed = false
  publicationMs = 0

  constructor(
    private readonly database: JournalHostDatabase,
    readonly sessionId: string,
    readonly epoch: string
  ) {
    this.state = createJournalReducerState(sessionId, epoch)
  }

  get through(): number {
    return this.state.lastSequence
  }

  async verify(pacing: JournalCatchUpPacing): Promise<boolean> {
    const pages = rebuildJournalOutcomePages(
      () => this.database.db,
      this.sessionId,
      this.epoch,
      this.generation,
      this.through
    )
    let step = pacing.work(() => pages.next())
    while (!step.done) {
      if (
        !(await pacing.rest()) ||
        this.disposed ||
        readJournalSessionEpoch(this.database.db, this.sessionId) !== this.epoch
      ) {
        return false
      }
      step = pacing.work(() => pages.next())
    }
    const compare = equalJournalStatePages(this.state, step.value)
    let match = pacing.work(() => compare.next())
    while (!match.done) {
      if (
        !(await pacing.rest()) ||
        this.disposed ||
        readJournalSessionEpoch(this.database.db, this.sessionId) !== this.epoch
      ) {
        return false
      }
      match = pacing.work(() => compare.next())
    }
    if (!match.value) {
      throw new Error('converted journal outcomes differ from the complete input fold')
    }
    this.verified = this.through
    return true
  }

  page(): JournalCatchUpStep | 'verify' {
    const { database, sessionId, epoch, generation } = this
    let publicationStarted: number | undefined
    const result = database.transaction(
      (db) => {
        if (this.disposed || readJournalSessionEpoch(db, sessionId) !== epoch) {
          return 'retired'
        }
        if (journalOutcomeSource(db, sessionId, epoch)) {
          return 'retired'
        }
        if (!this.started) {
          db.prepare('INSERT INTO journal_outcome_attempts VALUES (?, ?, ?)').run(
            sessionId,
            epoch,
            generation
          )
          activeJournalGenerations.add(generation)
          this.started = true
        }
        const newest = db
          .prepare(`SELECT generation FROM journal_outcome_attempts
        WHERE session_id = ? AND epoch = ? ORDER BY rowid DESC LIMIT 1`)
          .get(sessionId, epoch)
        if (newest?.generation !== generation) {
          return 'retired'
        }
        const stored = readJournalRowsWithin(
          db,
          sessionId,
          epoch,
          this.through,
          JOURNAL_OUTCOME_PAGE_ROWS,
          JOURNAL_OUTCOME_PAGE_BYTES
        )
        if (stored.length > 0) {
          const rows: JournalRow[] = []
          let expected = this.through + 1
          for (const entry of stored) {
            const parsed = parseJournalRow(entry.rowJson)
            if (
              !parsed.ok ||
              parsed.row.seq !== entry.seq ||
              entry.seq !== expected ||
              (expected === 1 && parsed.row.kind !== 'epoch')
            ) {
              return 'parked'
            }
            rows.push(parsed.row)
            expected += 1
          }
          const times = new Map(stored.map((entry) => [entry.seq, entry.ts]))
          const transition = persistJournalOutcomeRows(
            db,
            this.state,
            generation,
            rows,
            (row) => times.get(row.seq) ?? row.ts,
            true
          )
          return { adopt: transition.adopt }
        }
        if (this.through === 0) {
          return 'parked'
        }
        if (this.verified !== this.through) {
          return 'verify'
        }
        // No tail remains at the verified epoch/attempt/sequence. Publication changes metadata only.
        publicationStarted = performance.now()
        publishJournalOutcomeSource(db, sessionId, epoch, generation, this.through)
        return 'current'
      },
      false,
      () => {
        if (publicationStarted !== undefined) {
          this.publicationMs = performance.now() - publicationStarted
        }
      }
    )
    if (typeof result === 'object') {
      this.state = result.adopt()
      return 'advanced'
    }
    return result
  }

  close(): void {
    this.disposed = true
    activeJournalGenerations.delete(this.generation)
    this.state = createJournalReducerState(this.sessionId, this.epoch)
  }
}

/** Compares insertion order and presence in byte-bounded units, excluding live Stop settlement. */
function* equalJournalStatePages(
  a: JournalReducerState,
  b: JournalReducerState
): Generator<void, boolean> {
  if (journalStateScalars(a) !== journalStateScalars(b)) {
    return false
  }
  const right = new Map(journalStateCollections(b).map((field) => [field.path, field.entries]))
  for (const field of journalStateCollections(a)) {
    const entries = right.get(field.path)?.[Symbol.iterator]()
    if (!entries) {
      return false
    }
    let bytes = 0
    let count = 0
    for (const [key, value] of field.entries) {
      const next = entries.next()
      const encoded = journalEntryJson(key, value)
      if (next.done || encoded !== journalEntryJson(next.value[0], next.value[1])) {
        return false
      }
      bytes += Buffer.byteLength(encoded)
      count += 1
      if (count >= 32 || bytes >= JOURNAL_OUTCOME_PAGE_BYTES) {
        bytes = 0
        count = 0
        yield
      }
    }
    if (!entries.next().done) {
      return false
    }
  }
  return true
}
