import type Database from '../../sqlite/sync-database'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'
import { JournalWriterChanges } from './journal-writer-changes'
import { applyJournalWriterEffect } from './journal-writer-effects'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { readJournalSqlMeta } from './journal-sql-meta'
import { planJournalWriterRows } from './journal-writer-plan'
import { journalInputOrder } from './journal-input-order'
import { journalInputAcceptance } from './journal-input-provenance'
import {
  advanceJournalOutcomeSource,
  journalOutcomeSource,
  startJournalOutcomeLog
} from './journal-outcome-format'
import { persistJournalOutcomeTransition } from './journal-outcome-table'
import { assertJournalFence } from './journal-write-guards'
import { journalContextCursor, projectJournalRows } from './journal-context-cursor'
import {
  isJournalOutputRevision,
  isJournalStreamedTextRevision
} from './journal-streamed-text-revision'

export class JournalSqlCommand {
  constructor(
    private readonly db: Database.Database,
    private readonly stateDirectory: string
  ) {}

  /** Conservative preflight only; all authority and revision assignment are repeated in apply(). */
  streamed(command: JournalWriterCommand): boolean {
    if (command.effects?.length || command.operation.kind !== 'item') {
      return false
    }
    try {
      const { reducer } = this.load(command)
      const row = planJournalWriterRows(reducer.state, command.operation)[0]!(
        reducer.state.lastSequence + 1,
        0
      )
      return isJournalStreamedTextRevision(reducer.state, row)
    } catch {
      // A stale/invalid command fails its own SAVEPOINT; it must not downgrade the batch.
      return false
    }
  }

  apply(command: JournalWriterCommand, savedAt: number): JournalWriterCommit {
    if (!this.db.isTransaction) {
      throw new Error('journal SQL command requires its transaction')
    }
    const { scope, reducer } = this.load(command)
    const { state } = reducer
    const rows = planJournalWriterRows(state, command.operation).map((build, index) =>
      build(state.lastSequence + index + 1, savedAt)
    )
    for (const row of rows) {
      assertJournalFence(row.fence, state.highestFence)
    }
    const inputChanged =
      rows.length > 0 &&
      (Boolean(command.effects?.length) || rows.some((row) => !isJournalOutputRevision(state, row)))
    const changes = new JournalWriterChanges()
    const abort = new AbortController()
    const inputKeys = journalInputOrder(state).captureKeys(new Set(), abort.signal)
    try {
      if (rows.length > 0) {
        const previous = journalOutcomeSource(this.db, state.sessionId, state.epoch)
        const source =
          previous ??
          startJournalOutcomeLog(this.db, state.sessionId, state.epoch, state.lastSequence, savedAt)
        if (source.through !== state.lastSequence) {
          throw new Error('journal outcome writer has stale coverage')
        }
        const transition = reducer.transition()
        persistJournalOutcomeTransition(
          this.db,
          {
            ...transition,
            changes: (reset) => {
              const entries = transition.changes(reset)
              changes.record(entries)
              return entries
            }
          },
          source,
          rows,
          savedAt,
          !previous || previous.format < 2,
          (next) => journalInputOrder(next).cards.ensure(next)
        )
        advanceJournalOutcomeSource(this.db, state.sessionId, state.epoch, state.lastSequence)
      }
      const projected = projectJournalRows(state, rows)
      const effects = (rows.length === 0 ? [] : (command.effects ?? [])).map((effect) =>
        applyJournalWriterEffect(this.db, this.stateDirectory, effect, projected)
      )
      this.db
        .prepare(`UPDATE journal_proj_meta SET through_seq=?
        WHERE session_id=? AND owner_token=?`)
        .run(state.lastSequence, state.sessionId, command.target.ownerToken)
      return {
        cursor: journalContextCursor(state),
        inputChanged,
        ...changes.finish(scope, state),
        inputKeys: [...inputKeys.changes],
        effects
      }
    } finally {
      abort.abort()
    }
  }

  private load(command: JournalWriterCommand) {
    const meta = readJournalSqlMeta(this.db, command.target)
    const source = journalOutcomeSource(this.db, command.target.sessionId, command.target.epoch)
    const through =
      source?.through ??
      Number(
        this.db
          .prepare(`SELECT MAX(seq) AS sequence
      FROM journal_rows WHERE session_id=? AND epoch=?`)
          .get(command.target.sessionId, command.target.epoch)?.sequence ?? 0
      )
    if (through !== meta.through) {
      throw new Error('journal projection no longer covers the saved chat')
    }
    const scope = new JournalSqlScope(this.db, command.target.sessionId, meta.generation)
    const reducer = new JournalSqlReducer(scope, command.target.epoch, (id) =>
      journalInputAcceptance(this.db, command.target.sessionId, id)
    )
    if (reducer.state.lastSequence !== meta.through) {
      throw new Error('journal projection writer has stale coverage')
    }
    return { scope, reducer }
  }
}
