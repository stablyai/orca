// Phase 7 finalization: the two-permission model and the DRIFT RECOMPUTATION.
//
// F1 is the one that distinguishes this lane from the plan lane. A plan artifact
// is bytes on disk, so a stored hash proves the reviewed content is unchanged. A
// candidate is DERIVED state, so the only equivalent proof is deriving it again —
// and a verdict about content that has since changed must be discarded, not
// recorded against the new content.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { finalizeCodeAuditRun } from './audited-code-audit-run-finalize'
import { cancelCodeAuditRun } from './audited-code-audit-run-cancel'
import { recoverInterruptedCodeAuditRuns } from './audited-code-audit-run-recovery'
import { decideCodeAuditOutcome } from './audited-code-audit-outcome'
import type { PlanAuditVerdictParseResult } from './audited-plan-audit-verdict'
import type { CodexProcessOutcome } from './audited-codex-process'

let repository: AuditedTaskRepository

const TASK_ID = 'task_1'
const CANDIDATE_ID = 'cand_1'
const TREE_OID = 'a'.repeat(40)
const RUN_ID = 'cra_1'
const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }

function db() {
  return repository.getDatabase()
}

function seed(state = 'awaiting_code_audit'): void {
  db()
    .prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
          state, plan_round, fix_round, current_candidate_id, created_at_ms, updated_at_ms)
       VALUES (?, 'r', '/p', 'b', 'local', 'T', '{}', 'custom', 'low', ?, 0, 0, ?, 1, 1)`
    )
    .run(TASK_ID, state, CANDIDATE_ID)
  db()
    .prepare(
      `INSERT INTO audited_candidates
         (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name, created_at_ms)
       VALUES (?, ?, 'exec_1', 0, 'current', ?, 'b', 'br', 1)`
    )
    .run(CANDIDATE_ID, TASK_ID, TREE_OID)
  db()
    .prepare(
      `INSERT INTO audited_code_audit_runs
         (id, task_id, candidate_id, candidate_tree_oid, round, status,
          worktree_verified_at_ms, started_at_ms)
       VALUES (?, ?, ?, ?, 0, 'running', 1, 1)`
    )
    .run(RUN_ID, TASK_ID, CANDIDATE_ID, TREE_OID)
}

const APPROVED = {
  runId: RUN_ID,
  taskId: TASK_ID,
  status: 'succeeded' as const,
  reasonCode: null,
  verdict: 'approved' as const,
  summary: 'Looks right',
  findingCount: 0,
  toState: 'awaiting_human_approval' as const,
  blockedReasonCode: null,
  preBlockState: null,
  blockedPhase: null,
  eventType: 'code_audit_approved_verdict',
  counters: COUNTERS,
  recomputedTreeOid: TREE_OID
}

function runRow() {
  return db().prepare(`SELECT * FROM audited_code_audit_runs WHERE id = ?`).get(RUN_ID) as Record<
    string,
    unknown
  >
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  seed()
})

afterEach(() => {
  repository.close()
})

describe('permission B: freshness', () => {
  // F1 — THE RECOMPUTATION CHECK.
  it('discards the verdict when the tree changed during the audit', () => {
    const taskBefore = db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)

    const result = finalizeCodeAuditRun(
      db(),
      { ...APPROVED, recomputedTreeOid: 'c'.repeat(40) },
      2_000
    )

    expect(result).toEqual({ ok: true, taskWritten: false })
    expect(runRow()).toMatchObject({
      status: 'failed',
      reason_code: 'candidate_drift',
      verdict: null
    })
    expect(db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)).toEqual(
      taskBefore
    )
  })

  it('treats a failed recomputation as drift, never as freshness', () => {
    finalizeCodeAuditRun(db(), { ...APPROVED, recomputedTreeOid: null }, 2_000)

    expect(runRow()).toMatchObject({ reason_code: 'candidate_drift', verdict: null })
    expect(repository.getTask(TASK_ID)!.state).toBe('awaiting_code_audit')
  })

  // F2
  it('discards the verdict when the candidate was superseded', () => {
    db()
      .prepare(`UPDATE audited_candidates SET status = 'superseded' WHERE id = ?`)
      .run(CANDIDATE_ID)

    const result = finalizeCodeAuditRun(db(), APPROVED, 2_000)

    expect(result).toEqual({ ok: true, taskWritten: false })
    expect(runRow()).toMatchObject({ reason_code: 'candidate_superseded', verdict: null })
  })

  // F3
  it('discards the verdict and leaves the task byte-identical when it moved state', () => {
    db().prepare(`UPDATE audited_tasks SET state = 'blocked' WHERE id = ?`).run(TASK_ID)
    const taskBefore = db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)

    finalizeCodeAuditRun(db(), APPROVED, 2_000)

    expect(runRow()).toMatchObject({ reason_code: 'task_state_changed', verdict: null })
    expect(db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)).toEqual(
      taskBefore
    )
  })
})

describe('verdict routing', () => {
  // F4 — the first writer of audit_approved_tree_oid, declared since Phase 1.
  it('approved moves to awaiting_human_approval AND binds the audited tree', () => {
    const result = finalizeCodeAuditRun(db(), APPROVED, 2_000)

    expect(result).toEqual({ ok: true, taskWritten: true })
    const task = repository.getTask(TASK_ID)!
    expect(task.state).toBe('awaiting_human_approval')
    expect(task.codeAuditVerdict).toBe('approved')
    expect(task.auditApprovedTreeOid).toBe(TREE_OID)
  })

  // F5
  it('fixes_requested parks the task without incrementing fix_round', () => {
    finalizeCodeAuditRun(
      db(),
      {
        ...APPROVED,
        verdict: 'fixes_requested',
        toState: 'code_fixes_requested',
        eventType: 'code_audit_fixes_requested'
      },
      2_000
    )

    const task = repository.getTask(TASK_ID)!
    expect(task.state).toBe('code_fixes_requested')
    // The counter moves when the FIX starts, not when it is requested.
    expect(task.fixRound).toBe(0)
    // No approved tree for a non-approved verdict.
    expect(task.auditApprovedTreeOid).toBeNull()
  })

  it('a blocked verdict blocks the task with pre_block_state set', () => {
    finalizeCodeAuditRun(
      db(),
      {
        ...APPROVED,
        verdict: 'blocked',
        toState: 'blocked',
        blockedReasonCode: 'code_audit_process_failed',
        preBlockState: 'awaiting_code_audit',
        blockedPhase: 'codeAudit',
        eventType: 'code_audit_blocked_verdict'
      },
      2_000
    )

    const task = repository.getTask(TASK_ID)!
    expect(task.state).toBe('blocked')
    expect(task.preBlockState).toBe('awaiting_code_audit')
    expect(task.auditApprovedTreeOid).toBeNull()
  })

  // F6
  it('refuses a duplicate finalize', () => {
    expect(finalizeCodeAuditRun(db(), APPROVED, 2_000)).toEqual({ ok: true, taskWritten: true })
    expect(finalizeCodeAuditRun(db(), APPROVED, 3_000)).toEqual({
      ok: false,
      reasonCode: 'lock_contended'
    })
  })
})

// F7 / F8 — the pure decision rules.
describe('decideCodeAuditOutcome', () => {
  const CLEAN_EXIT: CodexProcessOutcome = { kind: 'exit', exitCode: 0, stdout: '', stderr: '' }
  const APPROVED_PARSE: PlanAuditVerdictParseResult = {
    ok: true,
    verdict: 'approved',
    summary: 'ok',
    findingCount: 0,
    coverage: []
  }
  const base = { fixRound: 0, maxFixRounds: 3 }

  it('drift beats a clean exit AND a valid approved verdict', () => {
    const decision = decideCodeAuditOutcome({
      ...base,
      outcome: CLEAN_EXIT,
      driftReasonCode: 'head_moved_from_base_commit',
      parsed: APPROVED_PARSE
    })
    expect(decision).toMatchObject({
      reasonCode: 'unexpected_commit_detected',
      toState: 'blocked',
      verdict: null
    })
  })

  it.each([
    ['no parsed result', null],
    ['an unparseable result', { ok: false, reasonCode: 'verdict_unparseable' } as const]
  ])('a clean exit with %s is never an approval', (_label, parsed) => {
    const decision = decideCodeAuditOutcome({
      ...base,
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      parsed
    })
    expect(decision).toMatchObject({
      reasonCode: 'verdict_unparseable',
      blockedReasonCode: 'code_audit_unparseable',
      verdict: null
    })
  })

  it('approved advances to awaiting_human_approval', () => {
    const decision = decideCodeAuditOutcome({
      ...base,
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      parsed: APPROVED_PARSE
    })
    expect(decision).toMatchObject({
      status: 'succeeded',
      verdict: 'approved',
      toState: 'awaiting_human_approval'
    })
  })

  // R4 — the cap blocks instead of stranding the task with a dead button.
  it('blocks a fixes_requested verdict at the round cap', () => {
    const parsed: PlanAuditVerdictParseResult = {
      ok: true,
      verdict: 'fixes_requested',
      summary: 's',
      findingCount: 2,
      coverage: []
    }
    const atCap = decideCodeAuditOutcome({
      ...base,
      fixRound: 3,
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      parsed
    })
    expect(atCap).toMatchObject({
      toState: 'blocked',
      blockedReasonCode: 'code_audit_round_limit',
      reasonCode: 'round_limit_reached'
    })

    const belowCap = decideCodeAuditOutcome({
      ...base,
      fixRound: 2,
      outcome: CLEAN_EXIT,
      driftReasonCode: null,
      parsed
    })
    expect(belowCap).toMatchObject({ toState: 'code_fixes_requested' })
  })
})

// R1 / R2 — cancellation and restart.
describe('lifecycle', () => {
  it('cancel leaves the task in awaiting_code_audit with no verdict', () => {
    const taskBefore = db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)

    expect(cancelCodeAuditRun(db(), { runId: RUN_ID, taskId: TASK_ID }, 2_000)).toEqual({
      ok: true
    })

    expect(runRow()).toMatchObject({
      status: 'cancelled',
      reason_code: 'cancelled_by_user',
      verdict: null
    })
    // No task row write at all — the state was already correct.
    expect(db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)).toEqual(
      taskBefore
    )
    // The candidate survives, so the next audit judges the same tree.
    expect(
      db().prepare(`SELECT status FROM audited_candidates WHERE id = ?`).get(CANDIDATE_ID)
    ).toMatchObject({ status: 'current' })
  })

  it('restart marks the run interrupted and blocks the task for retry', () => {
    const recovered = recoverInterruptedCodeAuditRuns(db(), 5_000)

    expect(recovered).toEqual([{ taskId: TASK_ID, runId: RUN_ID }])
    expect(runRow()).toMatchObject({ status: 'interrupted', verdict: null })
    const task = repository.getTask(TASK_ID)!
    expect(task.state).toBe('blocked')
    expect(task.preBlockState).toBe('awaiting_code_audit')
  })

  it('recovery is idempotent', () => {
    recoverInterruptedCodeAuditRuns(db(), 5_000)
    expect(recoverInterruptedCodeAuditRuns(db(), 6_000)).toEqual([])
  })

  it('an interrupted run can never authorize: it is not succeeded', () => {
    recoverInterruptedCodeAuditRuns(db(), 5_000)
    const row = runRow()
    expect(row.status).not.toBe('succeeded')
    expect(row.verdict).toBeNull()
  })
})
