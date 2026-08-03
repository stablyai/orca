// Wires the SQLite repository, the state machine, and the sanitized projection
// together behind one entry point IPC handlers call into. Task creation from a
// custom spec (roadmap parsing arrives in Phase 9), the dev-build-gated manual
// transition control, and repository access shared with the Phase 2 triage
// orchestration in audited-triage-orchestration.ts. Later phase commands
// (plan, implement, ...) are added starting Phase 3+ per the plan's phased
// sequence.

import { join } from 'node:path'
import { app } from 'electron'
import {
  AuditedTaskRepository,
  type AuditedTaskRow,
  type CreateAuditedTaskInput
} from './audited-task-repository'
import {
  validateAuditedTransition,
  validateBlockTransition,
  validateRetryTransition,
  type AuditedTransitionCommand
} from './audited-workflow-state-machine'
import {
  buildAuditedTaskProjection,
  type ProjectionSourceTask
} from '../../shared/audited-workflow-projection'
import { getLatestExecutionRun } from './audited-execution-run-repository'
import type {
  AuditedTaskState,
  AuditedTaskStatusProjection
} from '../../shared/audited-workflow-types'

let repository: AuditedTaskRepository | undefined

// Why: lazy initialization — the DB path depends on Electron's userData, which
// may not be finalized until after app.ready. Mirrors
// OrcaRuntimeService.getOrchestrationDb(). Also allows tests to inject an
// in-memory repository without touching the filesystem.
export function getAuditedTaskRepository(): AuditedTaskRepository {
  if (!repository) {
    const dbPath = join(app.getPath('userData'), 'audited-workflow.db')
    repository = new AuditedTaskRepository(dbPath)
  }
  return repository
}

export function setAuditedTaskRepositoryForTests(repo: AuditedTaskRepository | undefined): void {
  repository = repo
}

function taskRowToProjectionSource(row: AuditedTaskRow): ProjectionSourceTask {
  // Phase 4: the latest run supplies the three projected execution facts. Only
  // status, reason code, and the truncation flag — never counters' content,
  // paths, or argv.
  const run = getLatestExecutionRun(getAuditedTaskRepository().getDatabase(), row.id)
  return {
    taskId: row.id,
    repoId: row.repoId,
    title: row.title,
    state: row.state,
    activePhase: row.activePhase,
    risk: row.risk,
    source: row.source,
    triageDecision: row.triageDecision,
    triageRunStatus: row.triageRunStatus,
    triageBlockedReasonCode: row.triageBlockedReasonCode,
    planRound: row.planRound,
    fixRound: row.fixRound,
    lastVerdict: null,
    blockedReasonCode: row.blockedReasonCode,
    approvalState: 'none',
    approvalExpiresAt: null,
    auditApprovedTreeOid: row.auditApprovedTreeOid,
    committedSha: row.committedSha,
    commitAttemptStatus: null,
    reconcileClass: null,
    reconcileReasonCode: null,
    worktreeProvenance: row.worktreeProvenance,
    worktreeVerifiedAt: row.worktreeVerifiedAt,
    worktreeReasonCode: row.worktreeReasonCode,
    executionRunStatus: run?.status ?? null,
    executionReasonCode: run?.reasonCode ?? null,
    executionOutputTruncated: run?.outputTruncated ?? false,
    acceptanceCriteria: [],
    timings: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function getTaskProjection(taskId: string): AuditedTaskStatusProjection | null {
  const row = getAuditedTaskRepository().getTask(taskId)
  return row ? buildAuditedTaskProjection(taskRowToProjectionSource(row)) : null
}

export function listTaskProjections(repoId?: string): AuditedTaskStatusProjection[] {
  return getAuditedTaskRepository()
    .listTasks(repoId)
    .map((row) => buildAuditedTaskProjection(taskRowToProjectionSource(row)))
}

export type SelectTaskResult = { taskId: string }

export function selectTask(input: CreateAuditedTaskInput): SelectTaskResult {
  const row = getAuditedTaskRepository().createTask(input)
  return { taskId: row.id }
}

export type ApplyDevTransitionResult =
  | { applied: true }
  | {
      applied: false
      reasonCode:
        | 'task_not_found'
        | 'illegal_transition'
        | 'unknown_command'
        | 'terminal_state'
        | 'lock_contended'
    }

/**
 * Dev-build-only manual transition, exercised through
 * ipc/audited-workflow-dev-transitions.ts (registered only when
 * `!app.isPackaged`). Drives the state machine directly for Phase 1 testing
 * without invoking any model or Git command.
 *
 * Race note: the state read below is a snapshot used only to DECIDE the
 * requested transition and to derive preBlockState/blockedReasonCode/
 * blockedPhase. The actual write is a compare-and-swap keyed on that same
 * snapshot's state (repo.applyTransition's `fromState`) — if another writer
 * moved the task's state between this read and the write, the CAS's WHERE
 * clause matches zero rows, no transition is recorded, and this returns
 * `lock_contended` instead of silently clobbering the concurrent write or
 * persisting a from_state that was never the row's real state at write time.
 */
export function applyDevTransition(
  taskId: string,
  command: AuditedTransitionCommand
): ApplyDevTransitionResult {
  const repo = getAuditedTaskRepository()
  const existing = repo.getTask(taskId)
  if (!existing) {
    return { applied: false, reasonCode: 'task_not_found' }
  }

  const validation =
    command === 'blockFromInvariantViolation'
      ? validateBlockTransition(existing.state)
      : command === 'retry'
        ? validateRetryTransition(existing.state, existing.preBlockState)
        : validateAuditedTransition(command, existing.state)

  if (!validation.ok) {
    return { applied: false, reasonCode: validation.reasonCode }
  }

  const enteringBlocked = validation.rule.to === 'blocked'
  const leavingBlocked = command === 'retry'

  const result = repo.applyTransition({
    taskId,
    fromState: existing.state,
    toState: validation.rule.to,
    actor: validation.rule.actor,
    eventType: `dev_transition_${command}`,
    preBlockState: enteringBlocked
      ? existing.state
      : leavingBlocked
        ? null
        : existing.preBlockState,
    blockedReasonCode: enteringBlocked
      ? 'dev_transition_unavailable'
      : leavingBlocked
        ? null
        : existing.blockedReasonCode,
    blockedPhase: enteringBlocked
      ? existing.activePhase
      : leavingBlocked
        ? null
        : existing.blockedPhase
  })

  if (!result.ok) {
    return { applied: false, reasonCode: result.reasonCode }
  }

  return { applied: true }
}

export function resolveRetryTarget(taskId: string): AuditedTaskState | null {
  const row = getAuditedTaskRepository().getTask(taskId)
  return row?.preBlockState ?? null
}
