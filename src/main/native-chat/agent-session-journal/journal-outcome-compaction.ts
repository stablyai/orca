import type { JournalReadConnection } from './journal-sql-owner'
import type {
  JournalCompactionSource as Active,
  JournalCompactionProgress as Progress
} from './journal-maintenance-unit'
import { admitsJournalCompactionFormat } from './journal-native-compaction'
import type { JournalHostDatabase } from './journal-host-database'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import { AgentSessionJournalError } from './journal-write-guards'
import type { JournalOutcomeSource } from './journal-outcome-format'
/** Keeps first/latest values and removal facts; newest values carry their canonical order.
 * Pass coverage is disposable: a restart rescans safely, and an unchanged chat reads no records. */
export class JournalOutcomeCompaction {
  private generation = 0
  private active: Active | null = null
  private previous = new Map<number, number>()
  private completed = new Map<number, number>()

  async page(
    database: Pick<JournalHostDatabase, 'read' | 'maintenance'>,
    charge: (ms: number) => void = () => {}
  ): Promise<boolean> {
    const active = this.active ?? (await database.read((read) => this.discover(read)))
    const result = 'more' in active ? null : await database.maintenance({ kind: 'compact', active })
    if (result) {
      charge(result.elapsed)
    }
    const progress = 'more' in active ? active : result?.progress
    if (!progress) {
      throw new Error('Native compaction progress is missing')
    }
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

  private async discover(db: JournalReadConnection): Promise<Progress | Active> {
    // Page the registry too: a page never scans all chats or all retired generations.
    const row = await db
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
      !admitsJournalCompactionFormat(row.format)
    ) {
      return next
    }
    if (this.previous.get(generation) === row.through_seq) {
      return { ...next, done: [generation, row.through_seq] }
    }
    let source: JournalOutcomeSource | null
    try {
      source = await db.source(row.session_id, row.epoch)
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
    return source
      ? {
          ...source,
          sessionId: row.session_id,
          epoch: row.epoch,
          after: { seq: 0, field: '', key: '' }
        }
      : next
  }
}
