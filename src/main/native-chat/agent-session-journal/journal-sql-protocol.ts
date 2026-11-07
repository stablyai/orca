import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalWriterEffect, JournalWriterEffectResult } from './journal-writer-effects'
import type { JournalSqlFailure } from './journal-sql-failure'
import type { JournalSqlMaintenance, JournalSqlMaintenanceResult } from './journal-sql-maintenance'

export type JournalSqlRequest = {
  id: number
  command:
    | { type: 'write'; command: JournalWriterCommand }
    | { type: 'effects'; effects: readonly JournalWriterEffect[] }
    | { type: 'maintenance'; operation: JournalSqlMaintenance }
    | { type: 'close' }
}

export type JournalSqlResponse =
  | { type: 'ready'; readOnly: boolean }
  | { type: 'committed'; id: number; commit: JournalWriterCommit; postcommit?: JournalSqlFailure }
  | {
      type: 'effects'
      id: number
      results: JournalWriterEffectResult[]
      postcommit?: JournalSqlFailure
    }
  | { type: 'done'; id: number }
  | {
      type: 'maintenance'
      id: number
      result: JournalSqlMaintenanceResult
      postcommit?: JournalSqlFailure
    }
  | {
      type: 'failed'
      id?: number
      fatal?: boolean
      outcome: 'not-dispatched' | 'rolled-back' | 'indeterminate'
      error: JournalSqlFailure
    }
