// WORKTREE IDENTITY IS PART OF AUTHORITATIVE ADMISSION.
//
// Reloading the task after verification narrowed the stale-cwd window but did
// not close it: the artifact and acceptance criteria are read AFTER that reload
// and BEFORE the run row is inserted, so a concurrent identity mutation in that
// span would still have produced a run whose cwd was already wrong.
//
// The fix makes identity part of the admission CAS and returns the cwd the
// transaction itself read. These tests mutate durable identity in that exact
// span — using the criteria read as the injection point — and prove no run, no
// transition, and no spawn results.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => userData) }
}))

vi.mock('./audited-worktree-service', () => ({
  verifyWorktreeForTask: vi.fn(async () => ({ ok: true })),
  ensureWorktreeForTask: vi.fn(),
  setAuditedWorktreeStore: vi.fn(),
  rebuildAuditedWorktreeRegistry: vi.fn(),
  reconcileAuditedWorktreesOnStartup: vi.fn(),
  recoverWorktreeForTask: vi.fn()
}))

// The injection seam: criteria are resolved AFTER the refreshed read and just
// BEFORE admission, so mutating here lands precisely in the remaining window.
const resolveAcceptanceCriteria = vi.fn()
vi.mock('./audited-plan-audit-criteria', () => ({
  resolveAcceptanceCriteria: (...args: unknown[]) => resolveAcceptanceCriteria(...args)
}))

const codexRunner = vi.fn()

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { derivePlanArtifact } from './audited-plan-artifact-derivation'
import { getCurrentPlanArtifact } from './audited-plan-artifact-repository'
import { setAuditedCodexRunnerForTests } from './audited-plan-audit-launcher'
import { startPlanAudit } from './audited-plan-review-orchestration'
import {
  hasLivePlanReviewRun,
  startPlanReviewRun,
  type ExpectedWorktreeIdentity
} from './audited-plan-review-run-repository'
import { seedTriagedTask, startRun } from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository

const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
const WT_PATH = 'C:\\orca\\worktrees\\audited-1'
const MOVED_PATH = 'C:\\orca\\worktrees\\audited-1-MOVED'
const WT_BRANCH = 'audited/1'
const CRITERIA = [{ id: 'ac1', text: 'It works.', covered: false }]

function makeTask(): string {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: '/tmp/repo',
    baseCommit: 'a'.repeat(40),
    hostId: 'local',
    title: 'T',
    spec: { title: 'T', description: '' },
    source: 'custom',
    risk: 'low'
  }).id
}

function seedReviewableTask(): { taskId: string; artifactId: string; sha: string } {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = ?, branch_name = ?,
         worktree_provenance = 'orca_audited_v1', worktree_verified_at_ms = 1 WHERE id = ?`
    )
    .run(WT_PATH, WT_BRANCH, taskId)
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    {
      taskId,
      runId,
      round: 0,
      rawPlanText: 'A plan.',
      sanitizationContext: {},
      counters: COUNTERS
    },
    1_000
  )
  if (!derived.ok) {
    throw new Error('seed failed')
  }
  const artifact = getCurrentPlanArtifact(repository.getDatabase(), taskId)!
  return { taskId, artifactId: artifact.id, sha: artifact.contentSha256 }
}

function mutateIdentity(taskId: string, sql: string, ...params: string[]): void {
  repository
    .getDatabase()
    .prepare(sql)
    .run(...params, taskId)
}

function reviewRunCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) as n FROM audited_plan_review_runs WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

function transitionCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) as n FROM audited_transitions WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-admission-'))
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  codexRunner.mockReset()
  codexRunner.mockResolvedValue({ kind: 'exit', exitCode: 0, stdout: '', stderr: '' })
  setAuditedCodexRunnerForTests(codexRunner)
  resolveAcceptanceCriteria.mockReset()
  resolveAcceptanceCriteria.mockReturnValue({ ok: true, criteria: CRITERIA })
})

afterEach(() => {
  setAuditedCodexRunnerForTests(undefined)
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('identity mutated between the refreshed read and admission', () => {
  /** Mutates durable identity at the criteria read — inside the window. */
  function mutateDuringAdmission(mutate: () => void): void {
    resolveAcceptanceCriteria.mockImplementation(() => {
      mutate()
      return { ok: true, criteria: CRITERIA }
    })
  }

  it('refuses when the PATH moves, with no run, transition, or spawn', async () => {
    const { taskId } = seedReviewableTask()
    const transitionsBefore = transitionCount(taskId)
    mutateDuringAdmission(() => {
      mutateIdentity(taskId, `UPDATE audited_tasks SET worktree_path = ? WHERE id = ?`, MOVED_PATH)
    })

    const result = await startPlanAudit(taskId)

    expect(result).toEqual({
      ok: false,
      kind: 'planReview',
      reasonCode: 'worktree_identity_changed'
    })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
    expect(transitionCount(taskId)).toBe(transitionsBefore)
    expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
  })

  it('refuses when the BRANCH changes', async () => {
    const { taskId } = seedReviewableTask()
    mutateDuringAdmission(() => {
      mutateIdentity(taskId, `UPDATE audited_tasks SET branch_name = ? WHERE id = ?`, 'other')
    })

    expect(await startPlanAudit(taskId)).toMatchObject({
      reasonCode: 'worktree_identity_changed'
    })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('refuses when PROVENANCE is cleared', async () => {
    const { taskId } = seedReviewableTask()
    mutateDuringAdmission(() => {
      mutateIdentity(taskId, `UPDATE audited_tasks SET worktree_provenance = NULL WHERE id = ?`)
    })

    expect(await startPlanAudit(taskId)).toMatchObject({
      reasonCode: 'worktree_identity_changed'
    })
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('refuses when the VERIFICATION MARKER is cleared', async () => {
    const { taskId } = seedReviewableTask()
    mutateDuringAdmission(() => {
      mutateIdentity(taskId, `UPDATE audited_tasks SET worktree_verified_at_ms = NULL WHERE id = ?`)
    })

    expect(await startPlanAudit(taskId)).toMatchObject({
      reasonCode: 'worktree_identity_changed'
    })
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('refuses when a worktree REASON CODE appears', async () => {
    const { taskId } = seedReviewableTask()
    mutateDuringAdmission(() => {
      mutateIdentity(
        taskId,
        `UPDATE audited_tasks SET worktree_reason_code = 'worktree_missing' WHERE id = ?`
      )
    })

    expect(await startPlanAudit(taskId)).toMatchObject({
      reasonCode: 'worktree_identity_changed'
    })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('re-verified marker value counts: a NEW verification timestamp refuses', async () => {
    // The marker is part of the fingerprint, so even a re-verification that
    // leaves the path intact invalidates an in-flight admission.
    const { taskId } = seedReviewableTask()
    mutateDuringAdmission(() => {
      mutateIdentity(taskId, `UPDATE audited_tasks SET worktree_verified_at_ms = 999 WHERE id = ?`)
    })

    expect(await startPlanAudit(taskId)).toMatchObject({
      reasonCode: 'worktree_identity_changed'
    })
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('still launches normally with the CURRENT persisted cwd', async () => {
    const { taskId } = seedReviewableTask()

    const result = await startPlanAudit(taskId)

    expect(result).toEqual({ ok: true })
    expect(codexRunner).toHaveBeenCalledTimes(1)
    expect(codexRunner.mock.calls[0]![0].worktreePath).toBe(WT_PATH)
    expect(reviewRunCount(taskId)).toBe(1)
  })
})

describe('hasLivePlanReviewRun — the writer guard', () => {
  // ensureWorktreeForTask is the only supported writer that can change a task's
  // worktree identity after provisioning, and it is renderer-reachable through
  // auditedWorkflow:verifyWorktree with nothing but a taskId. It consults this
  // predicate and refuses while a review owns the worktree, which is what keeps
  // the admitted identity true for the LIFE of the run rather than only at
  // insert time.
  it('is false with no review, true while one is running', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    expect(hasLivePlanReviewRun(repository.getDatabase(), taskId)).toBe(false)

    const started = startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: {
          worktreePath: WT_PATH,
          branchName: WT_BRANCH,
          worktreeProvenance: 'orca_audited_v1',
          worktreeVerifiedAt: 1,
          worktreeReasonCode: null
        }
      },
      1_000
    )
    expect(started.ok).toBe(true)
    expect(hasLivePlanReviewRun(repository.getDatabase(), taskId)).toBe(true)
  })

  it('becomes false again once the run is finalized', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: {
          worktreePath: WT_PATH,
          branchName: WT_BRANCH,
          worktreeProvenance: 'orca_audited_v1',
          worktreeVerifiedAt: 1,
          worktreeReasonCode: null
        }
      },
      1_000
    )
    repository
      .getDatabase()
      .prepare(`UPDATE audited_plan_review_runs SET status = 'cancelled' WHERE task_id = ?`)
      .run(taskId)

    // Cancelling frees the worktree for identity writes again — no new state
    // was needed to express this.
    expect(hasLivePlanReviewRun(repository.getDatabase(), taskId)).toBe(false)
  })

  it('is scoped to the task', () => {
    const first = seedReviewableTask()
    const second = seedReviewableTask()
    startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId: first.taskId,
        artifactId: first.artifactId,
        artifactSha256: first.sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: {
          worktreePath: WT_PATH,
          branchName: WT_BRANCH,
          worktreeProvenance: 'orca_audited_v1',
          worktreeVerifiedAt: 1,
          worktreeReasonCode: null
        }
      },
      1_000
    )
    expect(hasLivePlanReviewRun(repository.getDatabase(), first.taskId)).toBe(true)
    expect(hasLivePlanReviewRun(repository.getDatabase(), second.taskId)).toBe(false)
  })
})

describe('startPlanReviewRun identity CAS', () => {
  const IDENTITY: ExpectedWorktreeIdentity = {
    worktreePath: WT_PATH,
    branchName: WT_BRANCH,
    worktreeProvenance: 'orca_audited_v1',
    worktreeVerifiedAt: 1,
    worktreeReasonCode: null
  }

  function admit(taskId: string, artifactId: string, sha: string, identity = IDENTITY) {
    return startPlanReviewRun(
      repository.getDatabase(),
      {
        taskId,
        artifactId,
        artifactSha256: sha,
        round: 0,
        worktreeVerifiedAtMs: 1,
        expectedWorktreeIdentity: identity
      },
      1_000
    )
  }

  it('returns the cwd it read INSIDE the transaction', () => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    const result = admit(taskId, artifactId, sha)
    expect(result).toMatchObject({ ok: true, worktreePath: WT_PATH })
  })

  it.each([
    ['a different path', { ...IDENTITY, worktreePath: MOVED_PATH }],
    ['a different branch', { ...IDENTITY, branchName: 'nope' }],
    ['different provenance', { ...IDENTITY, worktreeProvenance: 'other' }],
    ['a different verification marker', { ...IDENTITY, worktreeVerifiedAt: 42 }]
  ])('refuses when the expected identity carries %s', (_label, identity) => {
    const { taskId, artifactId, sha } = seedReviewableTask()
    expect(admit(taskId, artifactId, sha, identity)).toEqual({
      ok: false,
      reasonCode: 'worktree_identity_changed'
    })
    expect(reviewRunCount(taskId)).toBe(0)
  })
})
