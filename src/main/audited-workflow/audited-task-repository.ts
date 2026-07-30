// Thin orchestrating class over the audited-workflow SQLite database. Schema
// lives in audited-task-schema.ts, row mapping in
// audited-task-row-mapping.ts, atomic task creation in
// audited-task-creation.ts, and compare-and-swap transition persistence in
// audited-task-transitions.ts — see each module's header for why it's split
// out. This keeps every file's responsibility legible and each one under the
// repository's max-lines budget without a suppression.
import Database from '../sqlite/sync-database'
import { createAuditedWorkflowTables, migrateAuditedWorkflowSchema } from './audited-task-schema'
import {
  sqliteRowToTask,
  sqliteRowToTransition,
  type AuditedTaskRow
} from './audited-task-row-mapping'
import {
  createAuditedTaskAtomically,
  type CreateAuditedTaskInput,
  type AuditedTaskSpec
} from './audited-task-creation'
import { applyTransitionCas, type ApplyTransitionResult } from './audited-task-transitions'
import {
  startTriageRun,
  finalizeTriageRunSucceeded,
  finalizeTriageRunBlocked,
  type StartTriageRunResult,
  type FinalizeTriageRunSuccessArgs,
  type FinalizeTriageRunBlockedArgs,
  type FinalizeTriageRunResult
} from './audited-triage-run-repository'
import { retryTriageRun, type RetryTriageRunResult } from './audited-triage-run-retry'
import {
  recoverInterruptedTriageRuns,
  type RecoveredInterruptedTriageRun
} from './audited-triage-run-recovery'
import type {
  AuditedTaskActor,
  AuditedTaskState,
  AuditedTaskTransitionRecord
} from '../../shared/audited-workflow-types'

export type {
  AuditedTaskRow,
  CreateAuditedTaskInput,
  AuditedTaskSpec,
  ApplyTransitionResult,
  StartTriageRunResult,
  FinalizeTriageRunSuccessArgs,
  FinalizeTriageRunBlockedArgs,
  FinalizeTriageRunResult,
  RetryTriageRunResult,
  RecoveredInterruptedTriageRun
}

function nowMs(): number {
  return Date.now()
}

export type ApplyTransitionArgs = {
  taskId: string
  fromState: AuditedTaskState
  toState: AuditedTaskState
  actor: AuditedTaskActor
  eventType: string
  reasonCode?: string | null
  preBlockState?: AuditedTaskState | null
  blockedReasonCode?: string | null
  blockedPhase?: string | null
}

export class AuditedTaskRepository {
  private db: Database.Database

  constructor(dbPath: string | ':memory:') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = NORMAL')
    this.db.pragma('busy_timeout = 5000')
    createAuditedWorkflowTables(this.db)
    migrateAuditedWorkflowSchema(this.db)
  }

  createTask(input: CreateAuditedTaskInput): AuditedTaskRow {
    return createAuditedTaskAtomically(this.db, input, nowMs())
  }

  getTask(taskId: string): AuditedTaskRow | null {
    const row = this.db.prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(taskId) as
      | Record<string, unknown>
      | undefined
    return row ? sqliteRowToTask(row) : null
  }

  listTasks(repoId?: string): AuditedTaskRow[] {
    // Why: created_at_ms alone can tie within the same millisecond under fast
    // sequential creation; rowid (SQLite's implicit monotonic insert order)
    // breaks ties deterministically without needing a separate sequence column.
    const rows = repoId
      ? (this.db
          .prepare(
            `SELECT * FROM audited_tasks WHERE repo_id = ? ORDER BY created_at_ms DESC, rowid DESC`
          )
          .all(repoId) as Record<string, unknown>[])
      : (this.db
          .prepare(`SELECT * FROM audited_tasks ORDER BY created_at_ms DESC, rowid DESC`)
          .all() as Record<string, unknown>[])
    return rows.map(sqliteRowToTask)
  }

  listTransitions(taskId: string): AuditedTaskTransitionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM audited_transitions WHERE task_id = ? ORDER BY seq ASC`)
      .all(taskId) as Record<string, unknown>[]
    return rows.map(sqliteRowToTransition)
  }

  /**
   * Compare-and-swap transition: only applies if the row is still in
   * `args.fromState` at write time. Returns `{ ok: false, reasonCode:
   * 'lock_contended' }` rather than writing misleading history when the
   * state has moved since the caller last read it. See
   * audited-task-transitions.ts for the full race-elimination rationale.
   */
  applyTransition(args: ApplyTransitionArgs): ApplyTransitionResult {
    return applyTransitionCas(this.db, args, nowMs())
  }

  startTriageRun(taskId: string): StartTriageRunResult {
    return startTriageRun(this.db, taskId, nowMs())
  }

  finalizeTriageRunSucceeded(args: FinalizeTriageRunSuccessArgs): FinalizeTriageRunResult {
    return finalizeTriageRunSucceeded(this.db, args, nowMs())
  }

  finalizeTriageRunBlocked(args: FinalizeTriageRunBlockedArgs): FinalizeTriageRunResult {
    return finalizeTriageRunBlocked(this.db, args, nowMs())
  }

  retryTriageRun(taskId: string): RetryTriageRunResult {
    return retryTriageRun(this.db, taskId, nowMs())
  }

  recoverInterruptedTriageRuns(): RecoveredInterruptedTriageRun[] {
    return recoverInterruptedTriageRuns(this.db, nowMs())
  }

  // Why exposed: Phase 3 worktree modules compose several statements per
  // operation (attempt CAS + task write + registry publication) and are unit
  // tested directly against a database handle, rather than through a widened
  // repository surface that would duplicate each of their contracts here.
  getDatabase(): Database.Database {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}
