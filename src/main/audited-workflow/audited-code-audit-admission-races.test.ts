// THE FIX-LANE RACE (Phase 7).
//
// `awaiting_code_audit` is not a quiescent state: a `fix` run ENTERS it at start
// and lives there while Claude edits the worktree, and the previous candidate
// stays `current` until the fix completes. So "task is awaiting_code_audit and a
// current candidate exists" is satisfied DURING a running fix.
//
// X1/X2 prove no Codex process is spawned in that window — asserted on the runner
// seam, deterministically, not by timing. X3/X4 prove the complementary
// direction: a completing fix cannot supersede the candidate an in-flight audit
// is judging.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

// Worktree verification is not what these tests exercise; stub it so admission
// reaches (or is refused before) the CAS deterministically.
vi.mock('./audited-worktree-service', () => ({
  verifyWorktreeForTask: vi.fn(async () => ({ ok: true }) as { ok: true }),
  ensureWorktreeForTask: vi.fn(),
  setAuditedWorktreeStore: vi.fn(),
  rebuildAuditedWorktreeRegistry: vi.fn(),
  reconcileAuditedWorktreesOnStartup: vi.fn(),
  recoverWorktreeForTask: vi.fn()
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { setAuditedCodeAuditRunnerForTests } from './audited-code-audit-launcher'
import { startCodeAudit } from './audited-code-audit-orchestration'
import { startCodeAuditRun } from './audited-code-audit-run-repository'
import { attachCandidate } from './audited-candidate-repository'
import { hasLiveExecutionRun } from './audited-execution-run-repository'

let repository: AuditedTaskRepository
let spawnCount = 0

const TASK_ID = 'task_1'
const CANDIDATE_ID = 'cand_1'
const TREE_OID = 'a'.repeat(40)
const BASE_COMMIT = 'b'.repeat(40)

const IDENTITY = {
  worktreePath: '/tmp/wt',
  branchName: 'orca/audited-1',
  worktreeProvenance: 'orca_audited_v1',
  worktreeVerifiedAt: 10,
  worktreeReasonCode: null
} as const

function db() {
  return repository.getDatabase()
}

/** A task resting in awaiting_code_audit with one current candidate. */
function seedAuditableTask(): void {
  db()
    .prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
          state, plan_round, fix_round, current_candidate_id,
          worktree_path, branch_name, worktree_provenance, worktree_verified_at_ms,
          created_at_ms, updated_at_ms)
       VALUES (?, 'r', '/tmp/repo', ?, 'local', 'T', '{}', 'custom', 'low',
               'awaiting_code_audit', 0, 0, ?, ?, ?, ?, ?, 1, 1)`
    )
    .run(
      TASK_ID,
      BASE_COMMIT,
      CANDIDATE_ID,
      IDENTITY.worktreePath,
      IDENTITY.branchName,
      IDENTITY.worktreeProvenance,
      IDENTITY.worktreeVerifiedAt
    )
  db()
    .prepare(
      `INSERT INTO audited_candidates
         (id, task_id, run_id, round, status, tree_oid, base_commit, branch_name, created_at_ms)
       VALUES (?, ?, 'exec_prev', 0, 'current', ?, ?, ?, 1)`
    )
    .run(CANDIDATE_ID, TASK_ID, TREE_OID, BASE_COMMIT, IDENTITY.branchName)
}

/** A LIVE Claude run — the fix that is actively editing the worktree. */
function seedRunningExecution(runId = 'exec_fix'): string {
  db()
    .prepare(
      `INSERT INTO audited_execution_runs
         (id, task_id, mode, status, pre_launch_state, active_run_state,
          worktree_verified_at_ms, started_at_ms)
       VALUES (?, ?, 'fix', 'running', 'code_fixes_requested', 'awaiting_code_audit', 1, 1)`
    )
    .run(runId, TASK_ID)
  return runId
}

function seedRunningAudit(runId = 'cra_live'): string {
  db()
    .prepare(
      `INSERT INTO audited_code_audit_runs
         (id, task_id, candidate_id, candidate_tree_oid, round, status,
          worktree_verified_at_ms, started_at_ms)
       VALUES (?, ?, ?, ?, 0, 'running', 1, 1)`
    )
    .run(runId, TASK_ID, CANDIDATE_ID, TREE_OID)
  return runId
}

function auditRunCount(): number {
  return (db().prepare(`SELECT COUNT(*) as n FROM audited_code_audit_runs`).get() as { n: number })
    .n
}

function startArgs() {
  return {
    taskId: TASK_ID,
    candidateId: CANDIDATE_ID,
    candidateTreeOid: TREE_OID,
    round: 0,
    worktreeVerifiedAtMs: IDENTITY.worktreeVerifiedAt,
    expectedWorktreeIdentity: IDENTITY,
    // These cases exercise ADMISSION, which is transport-agnostic. The CLI mode
    // keeps them asserting the same behaviour they always did.
    auditMode: 'codex_cli' as const
  }
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  spawnCount = 0
  // Any invocation of this runner means a Codex process WOULD have started.
  setAuditedCodeAuditRunnerForTests(async () => {
    spawnCount += 1
    return { kind: 'exit', exitCode: 0, stdout: '', stderr: '' }
  })
  seedAuditableTask()
})

afterEach(() => {
  setAuditedCodeAuditRunnerForTests(undefined)
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
})

describe('X1: no audit spawns while a fix run is live', () => {
  it('refuses startCodeAudit with execution_in_progress and never reaches the runner', async () => {
    seedRunningExecution()

    const result = await startCodeAudit(TASK_ID)

    expect(result).toEqual({ ok: false, kind: 'codeAudit', reasonCode: 'execution_in_progress' })
    // The deterministic assertion: the spawn seam was never touched.
    expect(spawnCount).toBe(0)
    expect(auditRunCount()).toBe(0)
  })

  it('leaves the task and its candidate byte-identical', async () => {
    seedRunningExecution()
    const taskBefore = db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)
    const candidateBefore = db()
      .prepare(`SELECT * FROM audited_candidates WHERE id = ?`)
      .get(CANDIDATE_ID)

    await startCodeAudit(TASK_ID)

    expect(db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)).toEqual(
      taskBefore
    )
    expect(db().prepare(`SELECT * FROM audited_candidates WHERE id = ?`).get(CANDIDATE_ID)).toEqual(
      candidateBefore
    )
  })
})

describe('X2: the guard is inside the CAS, not merely advisory', () => {
  // Simulates a fix starting in the window AFTER a pre-check would have passed
  // and BEFORE the insert: the transaction must still refuse.
  it('refuses at insert time even when the pre-check would have passed', () => {
    expect(hasLiveExecutionRun(db(), TASK_ID)).toBe(false) // pre-check would pass

    seedRunningExecution() // ...then the fix starts

    const result = startCodeAuditRun(db(), startArgs(), 2_000)

    expect(result).toEqual({ ok: false, reasonCode: 'execution_in_progress' })
    expect(auditRunCount()).toBe(0)
  })

  it('admits normally once the execution run is terminal', () => {
    const runId = seedRunningExecution()
    db().prepare(`UPDATE audited_execution_runs SET status = 'succeeded' WHERE id = ?`).run(runId)

    const result = startCodeAuditRun(db(), startArgs(), 2_000)

    expect(result.ok).toBe(true)
    expect(auditRunCount()).toBe(1)
  })

  it('refuses a second audit through the partial unique index', () => {
    expect(startCodeAuditRun(db(), startArgs(), 2_000).ok).toBe(true)
    expect(startCodeAuditRun(db(), startArgs(), 3_000)).toEqual({
      ok: false,
      reasonCode: 'lock_contended'
    })
    expect(auditRunCount()).toBe(1)
  })

  it('refuses when the recorded tree no longer matches the candidate row', () => {
    const result = startCodeAuditRun(
      db(),
      { ...startArgs(), candidateTreeOid: 'c'.repeat(40) },
      2_000
    )
    expect(result).toEqual({ ok: false, reasonCode: 'candidate_drift' })
    expect(auditRunCount()).toBe(0)
  })
})

describe('X3: candidate derivation cannot race an admitted audit', () => {
  const attachArgs = {
    candidateId: 'cand_2',
    taskId: TASK_ID,
    runId: 'exec_fix',
    round: 1,
    treeOid: 'd'.repeat(40),
    baseCommit: BASE_COMMIT,
    branchName: IDENTITY.branchName,
    activeRunState: 'awaiting_code_audit' as const,
    counters: { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
  }

  it('refuses attachCandidate with code_audit_in_progress', () => {
    seedRunningExecution('exec_fix')
    seedRunningAudit()
    const taskBefore = db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)

    const result = attachCandidate(db(), attachArgs, 3_000)

    expect(result).toEqual({ ok: false, reasonCode: 'code_audit_in_progress' })
    // The current candidate is unchanged and the task is byte-identical.
    expect(db().prepare(`SELECT * FROM audited_tasks WHERE id = ?`).get(TASK_ID)).toEqual(
      taskBefore
    )
    expect(
      (db().prepare(`SELECT COUNT(*) as n FROM audited_candidates`).get() as { n: number }).n
    ).toBe(1)
  })

  it('attaches normally once the audit is terminal', () => {
    seedRunningExecution('exec_fix')
    const auditId = seedRunningAudit()
    db()
      .prepare(`UPDATE audited_code_audit_runs SET status = 'succeeded' WHERE id = ?`)
      .run(auditId)

    const result = attachCandidate(db(), attachArgs, 3_000)

    expect(result.ok).toBe(true)
    expect(result.ok && result.task.currentCandidateId).toBe('cand_2')
  })
})

describe('X4: both orderings converge', () => {
  it('audit-first leaves a fresh unaudited candidate after the fix lands', () => {
    // The audit finishes (terminal), then the fix attaches its new candidate.
    const auditId = seedRunningAudit()
    db()
      .prepare(
        `UPDATE audited_code_audit_runs SET status = 'succeeded', verdict = 'fixes_requested' WHERE id = ?`
      )
      .run(auditId)
    seedRunningExecution('exec_fix')

    const attached = attachCandidate(
      db(),
      {
        candidateId: 'cand_2',
        taskId: TASK_ID,
        runId: 'exec_fix',
        round: 1,
        treeOid: 'd'.repeat(40),
        baseCommit: BASE_COMMIT,
        branchName: IDENTITY.branchName,
        activeRunState: 'awaiting_code_audit',
        counters: { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
      },
      4_000
    )

    expect(attached.ok).toBe(true)
    const task = repository.getTask(TASK_ID)!
    expect(task.state).toBe('awaiting_code_audit')
    expect(task.currentCandidateId).toBe('cand_2')
    // A new candidate invalidates the prior audit outcome.
    expect(task.codeAuditVerdict).toBeNull()
    expect(task.auditApprovedTreeOid).toBeNull()
  })

  it('supersedes the old candidate rather than deleting it', () => {
    seedRunningExecution('exec_fix')
    attachCandidate(
      db(),
      {
        candidateId: 'cand_2',
        taskId: TASK_ID,
        runId: 'exec_fix',
        round: 1,
        treeOid: 'd'.repeat(40),
        baseCommit: BASE_COMMIT,
        branchName: IDENTITY.branchName,
        activeRunState: 'awaiting_code_audit',
        counters: { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
      },
      4_000
    )

    const old = db()
      .prepare(`SELECT status, superseded_by FROM audited_candidates WHERE id = ?`)
      .get(CANDIDATE_ID)
    expect(old).toMatchObject({ status: 'superseded', superseded_by: 'cand_2' })
  })
})

describe('X5: hasLiveExecutionRun is true only for running rows', () => {
  it.each(['succeeded', 'failed', 'cancelled', 'interrupted', 'blocked'])(
    'reports false for a %s run',
    (status) => {
      const runId = seedRunningExecution()
      db().prepare(`UPDATE audited_execution_runs SET status = ? WHERE id = ?`).run(status, runId)
      expect(hasLiveExecutionRun(db(), TASK_ID)).toBe(false)
    }
  )

  it('reports true for a running run', () => {
    seedRunningExecution()
    expect(hasLiveExecutionRun(db(), TASK_ID)).toBe(true)
  })

  it('is scoped to the task', () => {
    seedRunningExecution()
    expect(hasLiveExecutionRun(db(), 'other_task')).toBe(false)
  })
})
