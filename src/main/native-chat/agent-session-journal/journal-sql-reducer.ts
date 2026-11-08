import { createJournalReducerState, type JournalReducerState } from './projection/journal-reducer'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlValueContext } from './journal-sql-value-context'
import { JournalSqlItemValues } from './journal-sql-item-values'
import { JournalSqlKeyedMap } from './journal-sql-keyed-values'
import { JournalSqlScalars } from './journal-sql-scalars'
import { JournalSqlPauseMarks } from './journal-sql-pause-marks'
import { JournalSqlQueryFacts } from './journal-sql-query-facts'
import { sqlJournalStateQueries } from './journal-sql-state-queries'
import { sqlJournalIndexStorage } from './journal-sql-index-storage'
import { JournalDerivedTurnScope } from './projection/journal-derived-turn-scope'
import { setJournalOutcomeScalarReader } from './journal-outcome-scalars'
import type { JournalOutcomeTransition } from './outcomes/journal-outcome-table'
import type { JournalStopSettleFact } from './journal-writer-host-facts'

/** A SAVEPOINT owns this shell and its decoded values; the writer discards it after every command. */
export class JournalSqlReducer {
  readonly context: JournalSqlValueContext
  readonly state: JournalReducerState
  readonly facts: JournalSqlQueryFacts
  private readonly marks: JournalSqlPauseMarks
  private readonly scalars: JournalSqlScalars
  private scopeBefore: string | null

  constructor(scope: JournalSqlScope, epoch: string, stopSettle?: JournalStopSettleFact) {
    this.context = new JournalSqlValueContext(scope, new JournalSqlItemValues(scope))
    this.facts = new JournalSqlQueryFacts(this.context)
    const items = new JournalSqlKeyedMap<string, AgentJournalRenderItem>(this.context, 'items')
    const storage = sqlJournalIndexStorage({
      context: this.context,
      collections: { items: () => items },
      stateQueries: sqlJournalStateQueries(this.context, this.facts)
    })
    const state = createJournalReducerState(scope.sessionId, epoch, storage)
    this.scalars = new JournalSqlScalars(scope, 'reducer')
    const historyOrigin: JournalReducerState['historyOrigin'] = null
    this.scalars.define(state, {
      contextBoundary: 1,
      lastSequence: 0,
      lastActivityAt: 0,
      oldestSequence: 1,
      highestFence: 0,
      latestAcceptedTurnSequence: 0,
      historyOrigin
    })
    new JournalSqlScalars(scope, 'queue').define(state.queue, { revision: 0 })
    new JournalSqlScalars(scope, 'inputs').define(state.inputs, { revision: 0 })
    this.scopeBefore = this.scalars.get<string | null>('derivedTurnScope', null)
    state.derivedTurnScope = JournalDerivedTurnScope.restore(this.scopeBefore)
    this.marks = new JournalSqlPauseMarks(scope, stopSettle)
    Object.defineProperty(state, 'queuePauseMarks', {
      enumerable: true,
      get: () => this.marks.value,
      set: (value: JournalReducerState['queuePauseMarks']) => {
        this.marks.replace(value)
      }
    })
    this.state = state
    setJournalOutcomeScalarReader(state, () => this.outcomeScalars())
  }

  flush(): void {
    this.facts.flush()
    this.marks.flush()
    const current = this.state.derivedTurnScope.snapshot()
    if (current !== this.scopeBefore) {
      this.scalars.set('derivedTurnScope', current)
      this.scopeBefore = current
    }
  }

  transition(): JournalOutcomeTransition {
    return {
      state: this.state,
      input: (value) => this.context.input(value),
      changes: (reset) => this.context.changes(reset),
      untracked: this.context.untracked,
      flush: () => this.flush(),
      recorded: (generation, sequence) => this.context.items!.bind(generation, sequence)
    }
  }

  private outcomeScalars(): Record<string, unknown> {
    const state = this.state
    return {
      sessionId: state.sessionId,
      epoch: state.epoch,
      lastSequence: state.lastSequence,
      lastActivityAt: state.lastActivityAt,
      oldestSequence: state.oldestSequence,
      highestFence: state.highestFence,
      derivedTurnScope: state.derivedTurnScope.snapshot(),
      latestAcceptedTurnSequence: state.latestAcceptedTurnSequence,
      queuePauseMarks: this.marks.snapshot(),
      queue: { revision: state.queue.revision },
      historyOrigin: state.historyOrigin,
      ...(state.contextBoundary > 1 ? { contextBoundary: state.contextBoundary } : {})
    }
  }
}
