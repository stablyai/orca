import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalCheckpointOutage } from './database/journal-checkpoint-outages'
import type { JournalWriterCommit } from './journal-writer-changes'
import type { JournalWriterEffect, JournalWriterEffectResult } from './journal-writer-effects'
import type { JournalSqlFailure } from './journal-sql-failure'
import type { JournalSqlMaintenance, JournalSqlMaintenanceResult } from './journal-sql-maintenance'

export type JournalSqlRequest = {
  id: number
  batch?: { sessionId: string; steps: number; bytes: number }
  /** A chat with a send in flight: queued ahead of bulk work, never batched with it. */
  urgent?: true
  command:
    | { type: 'write'; command: JournalWriterCommand }
    | { type: 'effects'; effects: readonly JournalWriterEffect[] }
    | { type: 'maintenance'; operation: JournalSqlMaintenance }
    | { type: 'close' }
    /** Mark a chat's already queued writes urgent; no reply. */
    | { type: 'promote'; sessionId: string }
}

/** Where one request's time went inside the writer; `op` is a closed operation-kind word. */
export type JournalSqlTiming = {
  op: string
  /** Requests queued behind this one's drain, including it. */
  depth: number
  waitMs: number
  gateMs: number
  runMs: number
  batch: number
  walFrames: number
}

export type JournalSqlResponse =
  | { type: 'ready'; readOnly: boolean }
  | { type: 'checkpoint-outage'; outage: JournalCheckpointOutage }
  | { type: 'committed'; id: number; commit: JournalWriterCommit; timing?: JournalSqlTiming }
  | {
      type: 'effects'
      id: number
      results: JournalWriterEffectResult[]
      timing?: JournalSqlTiming
    }
  | { type: 'done'; id: number }
  | {
      type: 'maintenance'
      id: number
      result: JournalSqlMaintenanceResult
      timing?: JournalSqlTiming
    }
  | {
      type: 'failed'
      id?: number
      fatal?: boolean
      outcome: 'not-dispatched' | 'rolled-back' | 'indeterminate'
      error: JournalSqlFailure
      timing?: JournalSqlTiming
    }
