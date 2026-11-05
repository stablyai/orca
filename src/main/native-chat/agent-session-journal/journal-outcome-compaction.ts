import type { JournalHostDatabase } from './journal-host-database'
import { JournalOutcomeDecodeError } from './journal-outcome-codec'
import { AgentSessionJournalError } from './journal-write-guards'
import type { JournalOutcomeSource } from './journal-outcome-format'
import {
  admitsJournalOutcome,
  journalMaintenancePage,
  type JournalCompactionCandidate
} from './journal-maintenance-unit'
import type { JournalReadConnection } from './journal-sql-owner'

const PAGE_SIZE = 32
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
  private upper: number | undefined
  private active: Active | null = null
  private previous = new Map<number, number>()
  private completed = new Map<number, number>()

  async page(
    database: Pick<JournalHostDatabase, 'scan' | 'maintenance'>,
    charge: (ms: number) => void = () => {}
  ): Promise<boolean> {
    const discovered = await database.scan(async (read) => {
      const started = performance.now()
      try {
        return await this.advance(read)
      } finally {
        charge(performance.now() - started)
      }
    })
    let progress = discovered.progress
    if (discovered.rows) {
      const result = await database.maintenance({
        kind: 'compact',
        active: discovered.active!,
        rows: discovered.rows
      })
      charge(result.elapsed)
      if (!result.valid) {
        progress = { more: true, generation: discovered.active!.generation, active: null }
      }
    }
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

  private async advance(
    db: JournalReadConnection
  ): Promise<{ progress: Progress; active?: Active; rows?: JournalCompactionCandidate[] }> {
    if (this.active) {
      return this.compact(db, this.active)
    }
    if (this.upper === undefined) {
      const last = await db
        .prepare('SELECT MAX(generation) AS generation FROM journal_outcome_generations')
        .get()
      this.upper = typeof last?.generation === 'number' ? last.generation : 0
    }
    // Page the registry too: a page never scans all chats or all retired generations.
    const row = await db
      .prepare(`SELECT a.generation, e.session_id, e.epoch, e.through_seq, e.format
      FROM journal_outcome_generations a LEFT JOIN journal_outcome_epochs e
      ON e.generation = a.generation AND e.session_id = a.session_id AND e.epoch = a.epoch
      WHERE a.generation > ? AND a.generation <= ? ORDER BY a.generation LIMIT 1`)
      .get(this.generation, this.upper)
    if (!row) {
      this.upper = undefined
      return { progress: { more: false, generation: 0, active: null } }
    }
    const generation = Number(row.generation)
    const next: Progress = { more: true, generation, active: null }
    if (
      typeof row.session_id !== 'string' ||
      typeof row.epoch !== 'string' ||
      typeof row.through_seq !== 'number' ||
      typeof row.format !== 'number' ||
      !admitsJournalOutcome(row.format, 'items', '')
    ) {
      return { progress: next }
    }
    if (this.previous.get(generation) === row.through_seq) {
      return { progress: { ...next, done: [generation, row.through_seq] } }
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
        return { progress: next }
      }
      throw error
    }
    return {
      progress: {
        ...next,
        active: source && {
          ...source,
          sessionId: row.session_id,
          epoch: row.epoch,
          after: { seq: 0, field: '', key: '' }
        }
      }
    }
  }

  private async compact(
    db: JournalReadConnection,
    active: Active
  ): Promise<{ progress: Progress; active?: Active; rows?: JournalCompactionCandidate[] }> {
    const next: Progress = { more: true, generation: active.generation, active: null }
    const source = await db
      .prepare(
        `SELECT generation, format FROM journal_outcome_epochs WHERE session_id = ? AND epoch = ?`
      )
      .get(active.sessionId, active.epoch)
    if (
      source?.generation !== active.generation ||
      typeof source.format !== 'number' ||
      !admitsJournalOutcome(source.format, 'items', '')
    ) {
      return { progress: next }
    }
    const found = await db
      .prepare(`SELECT seq, field, entry_key, format, deleted, length(CAST(value_json AS BLOB)) AS bytes
      FROM journal_outcomes WHERE generation = ? AND (seq, field, entry_key) > (?, ?, ?)
      AND seq <= ? ORDER BY seq, field, entry_key LIMIT ${PAGE_SIZE}`)
      .all(
        active.generation,
        active.after.seq,
        active.after.field,
        active.after.key,
        active.through
      )
    const candidates: JournalCompactionCandidate[] = []
    let stopped = false
    for (const row of found) {
      if (
        typeof row.seq !== 'number' ||
        typeof row.field !== 'string' ||
        typeof row.entry_key !== 'string' ||
        typeof row.format !== 'number' ||
        typeof row.deleted !== 'number' ||
        typeof row.bytes !== 'number' ||
        !admitsJournalOutcome(row.format, row.field, row.entry_key)
      ) {
        stopped = true
        break
      }
      candidates.push({
        seq: row.seq,
        field: row.field,
        key: row.entry_key,
        format: row.format,
        deleted: row.deleted,
        bytes: row.bytes
      })
    }
    const rows = journalMaintenancePage(candidates)
    const last = rows.at(-1)
    const covered = rows.length === candidates.length
    const progress: Progress =
      stopped && covered
        ? next
        : covered && found.length < PAGE_SIZE
          ? { ...next, done: [active.generation, active.through] }
          : {
              ...next,
              active: last
                ? { ...active, after: { seq: last.seq, field: last.field, key: last.key } }
                : null
            }
    return { progress, active, rows }
  }
}
