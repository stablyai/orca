// Candidate ownership (Phase 7), mirroring attachPlanArtifact's contract.
//
// The tree was computed OUTSIDE any transaction, so between write-tree and the
// attach a cancel, a startup recovery, or an invariant block can legitimately
// have taken the task. Every check below is a way that race resolves safely.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import {
  attachCandidate,
  getCurrentCandidate,
  hasLiveCodeAuditRun
} from './audited-candidate-repository'

let repository: AuditedTaskRepository

const TASK_ID = 'task_1'
const RUN_ID = 'exec_1'
const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }

function db() {
  return repository.getDatabase()
}

function seedTask(state = 'implementing'): void {
  db()
    .prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
          state, plan_round, fix_round, created_at_ms, updated_at_ms)
       VALUES (?, 'r', '/p', 'b', 'local', 'T', '{}', 'custom', 'low', ?, 0, 0, 1, 1)`
    )
    .run(TASK_ID, state)
}

function seedRunningExecution(runId = RUN_ID, active = 'implementing'): void {
  db()
    .prepare(
      `INSERT INTO audited_execution_runs
         (id, task_id, mode, status, pre_launch_state, active_run_state,
          worktree_verified_at_ms, started_at_ms)
       VALUES (?, ?, 'direct', 'running', 'ready_to_implement', ?, 1, 1)`
    )
    .run(runId, TASK_ID, active)
}

function args(overrides: Partial<Parameters<typeof attachCandidate>[1]> = {}) {
  return {
    candidateId: 'cand_1',
    taskId: TASK_ID,
    runId: RUN_ID,
    round: 0,
    treeOid: 'a'.repeat(40),
    baseCommit: 'b',
    branchName: 'br',
    activeRunState: 'implementing' as const,
    counters: COUNTERS,
    ...overrides
  }
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
})

afterEach(() => {
  repository.close()
})

describe('attachCandidate', () => {
  it('attaches the candidate, moves the task, and completes the run', () => {
    seedTask()
    seedRunningExecution()

    const result = attachCandidate(db(), args(), 2_000)

    expect(result.ok).toBe(true)
    const task = repository.getTask(TASK_ID)!
    expect(task.state).toBe('awaiting_code_audit')
    expect(task.currentCandidateId).toBe('cand_1')
    expect(getCurrentCandidate(db(), TASK_ID)?.treeOid).toBe('a'.repeat(40))
    expect(
      db().prepare(`SELECT status FROM audited_execution_runs WHERE id = ?`).get(RUN_ID)
    ).toMatchObject({ status: 'succeeded' })
  })

  // A1
  it('refuses a duplicate derivation for the same run', () => {
    seedTask()
    seedRunningExecution()
    attachCandidate(db(), args(), 2_000)
    // Re-open a run row so check 1 passes and UNIQUE(run_id) is what refuses.
    db().prepare(`UPDATE audited_execution_runs SET status = 'running' WHERE id = ?`).run(RUN_ID)
    db().prepare(`UPDATE audited_tasks SET state = 'implementing' WHERE id = ?`).run(TASK_ID)

    const second = attachCandidate(db(), args({ candidateId: 'cand_2' }), 3_000)

    expect(second).toEqual({ ok: false, reasonCode: 'duplicate_candidate' })
    expect(
      (db().prepare(`SELECT COUNT(*) as n FROM audited_candidates`).get() as { n: number }).n
    ).toBe(1)
  })

  // A2
  it('supersedes the previous candidate without violating the one-current index', () => {
    seedTask()
    seedRunningExecution()
    attachCandidate(db(), args(), 2_000)

    db().prepare(`UPDATE audited_tasks SET state = 'implementing' WHERE id = ?`).run(TASK_ID)
    seedRunningExecution('exec_2')
    const second = attachCandidate(
      db(),
      args({ candidateId: 'cand_2', runId: 'exec_2', treeOid: 'c'.repeat(40) }),
      3_000
    )

    expect(second.ok).toBe(true)
    expect(getCurrentCandidate(db(), TASK_ID)?.id).toBe('cand_2')
    expect(
      db().prepare(`SELECT status, superseded_by FROM audited_candidates WHERE id = 'cand_1'`).get()
    ).toMatchObject({ status: 'superseded', superseded_by: 'cand_2' })
  })

  // A3
  it('writes nothing when the run is no longer running', () => {
    seedTask()
    seedRunningExecution()
    db().prepare(`UPDATE audited_execution_runs SET status = 'cancelled' WHERE id = ?`).run(RUN_ID)
    const taskBefore = db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)

    expect(attachCandidate(db(), args(), 2_000)).toEqual({
      ok: false,
      reasonCode: 'lock_contended'
    })
    expect(db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)).toEqual(
      taskBefore
    )
    expect(
      (db().prepare(`SELECT COUNT(*) as n FROM audited_candidates`).get() as { n: number }).n
    ).toBe(0)
  })

  it('writes nothing when the task moved out of the run state', () => {
    seedTask('blocked')
    seedRunningExecution()

    expect(attachCandidate(db(), args(), 2_000)).toEqual({
      ok: false,
      reasonCode: 'lock_contended'
    })
  })

  it('refuses a task that does not exist', () => {
    expect(attachCandidate(db(), args(), 2_000)).toEqual({
      ok: false,
      reasonCode: 'task_not_found'
    })
  })

  // A fix run attaches from awaiting_code_audit, not implementing.
  it('attaches a fix run from awaiting_code_audit', () => {
    seedTask('awaiting_code_audit')
    seedRunningExecution(RUN_ID, 'awaiting_code_audit')

    const result = attachCandidate(db(), args({ activeRunState: 'awaiting_code_audit' }), 2_000)

    expect(result.ok).toBe(true)
    expect(repository.getTask(TASK_ID)!.state).toBe('awaiting_code_audit')
  })

  // A new candidate invalidates any prior audit outcome.
  it('clears the approved tree and verdict when superseding', () => {
    seedTask('awaiting_code_audit')
    db()
      .prepare(
        `UPDATE audited_tasks SET audit_approved_tree_oid = 'old', code_audit_verdict = 'approved' WHERE id = ?`
      )
      .run(TASK_ID)
    seedRunningExecution(RUN_ID, 'awaiting_code_audit')

    attachCandidate(db(), args({ activeRunState: 'awaiting_code_audit' }), 2_000)

    const task = repository.getTask(TASK_ID)!
    expect(task.auditApprovedTreeOid).toBeNull()
    expect(task.codeAuditVerdict).toBeNull()
  })
})

describe('hasLiveCodeAuditRun', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'interrupted'])(
    'reports false for a %s audit',
    (status) => {
      db()
        .prepare(
          `INSERT INTO audited_code_audit_runs
             (id, task_id, candidate_id, candidate_tree_oid, round, status,
              worktree_verified_at_ms, started_at_ms)
           VALUES ('cra_1', ?, 'c', 'a', 0, ?, 1, 1)`
        )
        .run(TASK_ID, status)
      expect(hasLiveCodeAuditRun(db(), TASK_ID)).toBe(false)
    }
  )

  it('reports true for a running audit', () => {
    db()
      .prepare(
        `INSERT INTO audited_code_audit_runs
           (id, task_id, candidate_id, candidate_tree_oid, round, status,
            worktree_verified_at_ms, started_at_ms)
         VALUES ('cra_1', ?, 'c', 'a', 0, 'running', 1, 1)`
      )
      .run(TASK_ID)
    expect(hasLiveCodeAuditRun(db(), TASK_ID)).toBe(true)
  })
})
