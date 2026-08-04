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
import { getPlanArtifact } from './audited-plan-artifact-repository'
import {
  getLatestPlanReviewRun,
  hasApprovedVerdictForCurrentArtifact
} from './audited-plan-review-run-repository'
import { resolveAcceptanceCriteria } from './audited-plan-audit-criteria'
import { getCurrentCoverage } from './audited-plan-coverage-repository'
import { getCandidate } from './audited-candidate-repository'
import { getLatestCodeAuditRun } from './audited-code-audit-run-repository'
import { MAX_FIX_ROUNDS } from '../../shared/audited-code-audit-types'
import type Database from '../sqlite/sync-database'
import type {
  AuditedAcceptanceCriterion,
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

/**
 * The criteria the renderer sees, with the latest qualifying audit's coverage
 * applied (Phase 6).
 *
 * The criteria themselves come from the SAME authoritative resolver the Codex
 * audit judges against, re-validated from the succeeded triage run — so the
 * checklist and the audit can never be looking at different requirements. When
 * that resolver fails closed (missing, blank, or contract-violating stored JSON)
 * this yields `[]`, exactly matching the behaviour before Phase 6.
 *
 * `available` and the coverage map come from ONE repository call, so a criterion
 * can never be flagged from one run while availability reports another.
 */
function resolveProjectedCriteria(
  db: Database.Database,
  taskId: string
): { criteria: AuditedAcceptanceCriterion[]; coverageAvailable: boolean } {
  const resolved = resolveAcceptanceCriteria(db, taskId)
  if (!resolved.ok) {
    return { criteria: [], coverageAvailable: false }
  }
  const coverage = getCurrentCoverage(db, taskId)
  return {
    criteria: resolved.criteria.map((criterion) => {
      const row = coverage.byCriterionId.get(criterion.id)
      return {
        id: criterion.id,
        text: criterion.text,
        covered: row?.covered ?? false,
        ...(row?.note ? { note: row.note } : {})
      }
    }),
    coverageAvailable: coverage.available
  }
}

function taskRowToProjectionSource(row: AuditedTaskRow): ProjectionSourceTask {
  // Phase 4: the latest run supplies the three projected execution facts. Only
  // status, reason code, and the truncation flag — never counters' content,
  // paths, or argv.
  const db = getAuditedTaskRepository().getDatabase()
  const run = getLatestExecutionRun(db, row.id)
  // Phase 5: the artifact supplies only display metadata (never its hash or
  // path), and the latest review run supplies the verdict facts. The approval
  // authority is the SAME query approvePlan uses, so what the UI offers and what
  // the transaction permits cannot diverge.
  const artifact = row.currentPlanArtifactId ? getPlanArtifact(db, row.currentPlanArtifactId) : null
  const review = getLatestPlanReviewRun(db, row.id)
  // Phase 6: the first writer of the long-declared acceptanceCriteria field,
  // which was hardcoded to [] from Phase 1 until now.
  const coverage = resolveProjectedCriteria(db, row.id)
  // Phase 7: the first readers of the code-audit lane's durable state.
  const candidate = row.currentCandidateId ? getCandidate(db, row.currentCandidateId) : null
  const codeAudit = getLatestCodeAuditRun(db, row.id)
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
    // Phase 5 is the first writer of this long-declared field.
    lastVerdict: row.lastVerdict,
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
    planArtifactId: artifact?.id ?? null,
    planArtifactStatus: artifact?.status ?? null,
    planArtifactTruncated: artifact?.truncated ?? false,
    planArtifactRedactionCount: artifact?.redactionCount ?? 0,
    planReviewRunStatus: review?.status ?? null,
    planReviewVerdict: review?.verdict ?? null,
    planReviewReasonCode: review?.reasonCode ?? null,
    planReviewSummary: review?.summary ?? null,
    planReviewFindingCount: review?.findingCount ?? null,
    planReviewApprovedForCurrentArtifact: hasApprovedVerdictForCurrentArtifact(db, row.id),
    coverageAvailable: coverage.coverageAvailable,
    // Phase 7: the candidate supplies only its STATUS — never its tree OID, which
    // is authorization identity. The latest audit run supplies the verdict facts.
    candidateStatus: candidate?.status ?? null,
    codeAuditRunStatus: codeAudit?.status ?? null,
    codeAuditVerdict: codeAudit?.verdict ?? null,
    codeAuditReasonCode: codeAudit?.reasonCode ?? null,
    codeAuditSummary: codeAudit?.summary ?? null,
    codeAuditFindingCount: codeAudit?.findingCount ?? null,
    fixRoundLimit: MAX_FIX_ROUNDS,
    acceptanceCriteria: coverage.criteria,
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
