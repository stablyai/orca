// LAUNCH INPUTS COME FROM THE REFRESHED DURABLE ROW.
//
// Two findings are covered here, and they share one root cause: startPlanAudit
// reads the task, then AWAITS worktree verification (which itself reloads
// durable state), so anything captured before that await is stale by the time
// Codex is spawned.
//
//   1. STALE CWD — the pre-verification worktree path must never become the
//      spawn cwd. A concurrent identity change in that gap would otherwise send
//      Codex to a directory that is not the one just verified.
//   2. ACCEPTANCE CRITERIA — the prompt must carry the criteria the succeeded
//      triage run persisted, not an empty array. Auditing against nothing lets
//      Codex approve work that satisfies no stated requirement.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => userData) }
}))

// The seam that lets a test change durable state DURING verification — exactly
// the window the reload closes.
const verifyWorktreeForTask = vi.fn()
vi.mock('./audited-worktree-service', () => ({
  verifyWorktreeForTask: (...args: unknown[]) => verifyWorktreeForTask(...(args as [])),
  ensureWorktreeForTask: vi.fn(),
  setAuditedWorktreeStore: vi.fn(),
  rebuildAuditedWorktreeRegistry: vi.fn(),
  reconcileAuditedWorktreesOnStartup: vi.fn(),
  recoverWorktreeForTask: vi.fn()
}))

const codexRunner = vi.fn()

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { derivePlanArtifact } from './audited-plan-artifact-derivation'
import { setAuditedCodexRunnerForTests } from './audited-plan-audit-launcher'
import { startPlanAudit } from './audited-plan-review-orchestration'
import { resolveAcceptanceCriteria } from './audited-plan-audit-criteria'
import { seedTriagedTask, startRun } from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository

const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
const ORIGINAL_WORKTREE = 'C:\\orca\\worktrees\\audited-1'
const MOVED_WORKTREE = 'C:\\orca\\worktrees\\audited-1-MOVED'
const CRITERIA = [
  { id: 'ac1', text: 'The parser rejects an unknown verdict.', covered: false },
  { id: 'ac2', text: 'A cancelled run leaves no orphan process.', covered: false }
]

function makeTask(): string {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: '/tmp/repo',
    baseCommit: 'a'.repeat(40),
    hostId: 'local',
    title: 'Harden the parser',
    spec: { title: 'Harden the parser', description: 'Make it fail closed.' },
    source: 'custom',
    risk: 'low'
  }).id
}

function seedTriageRunWithCriteria(taskId: string, criteriaJson: string | null): void {
  repository
    .getDatabase()
    .prepare(
      `INSERT INTO audited_triage_runs
         (id, task_id, status, decision, acceptance_criteria_json, next_step_prompt,
          started_at_ms, ended_at_ms)
       VALUES (?, ?, 'succeeded', 'plan', ?, 'do the thing', 1, 2)`
    )
    .run(`triage_${taskId}`, taskId, criteriaJson)
}

/** A task in awaiting_plan_review with a complete worktree identity. */
function seedReviewableTask(criteriaJson: string | null = JSON.stringify(CRITERIA)): string {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = ?, branch_name = 'audited/1',
         worktree_provenance = 'orca_audited_v1', worktree_verified_at_ms = 1 WHERE id = ?`
    )
    .run(ORIGINAL_WORKTREE, taskId)
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    {
      taskId,
      runId,
      round: 0,
      rawPlanText: 'A plan body.',
      sanitizationContext: {},
      counters: COUNTERS
    },
    1_000
  )
  if (!derived.ok) {
    throw new Error('seed failed')
  }
  seedTriageRunWithCriteria(taskId, criteriaJson)
  return taskId
}

function setWorktree(taskId: string, path: string | null, branch: string | null): void {
  repository
    .getDatabase()
    .prepare(`UPDATE audited_tasks SET worktree_path = ?, branch_name = ? WHERE id = ?`)
    .run(path, branch, taskId)
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
  userData = mkdtempSync(join(tmpdir(), 'orca-launch-inputs-'))
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  codexRunner.mockReset()
  codexRunner.mockResolvedValue({ kind: 'exit', exitCode: 0, stdout: '', stderr: '' })
  setAuditedCodexRunnerForTests(codexRunner)
  verifyWorktreeForTask.mockReset()
  verifyWorktreeForTask.mockResolvedValue({ ok: true })
})

afterEach(() => {
  setAuditedCodexRunnerForTests(undefined)
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('stale-worktree launch race', () => {
  it('NEVER spawns with the pre-verification cwd after the path changes', async () => {
    const taskId = seedReviewableTask()
    // The concurrent writer lands DURING verification — the exact gap.
    verifyWorktreeForTask.mockImplementation(async () => {
      setWorktree(taskId, MOVED_WORKTREE, 'audited/1')
      return { ok: true }
    })

    const result = await startPlanAudit(taskId)

    expect(result).toEqual({
      ok: false,
      kind: 'planReview',
      reasonCode: 'worktree_identity_changed'
    })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('refuses when the BRANCH changes in the gap', async () => {
    const taskId = seedReviewableTask()
    verifyWorktreeForTask.mockImplementation(async () => {
      setWorktree(taskId, ORIGINAL_WORKTREE, 'audited/1-renamed')
      return { ok: true }
    })

    const result = await startPlanAudit(taskId)

    expect(result).toMatchObject({ ok: false, reasonCode: 'worktree_identity_changed' })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('refuses when the identity becomes INCOMPLETE in the gap', async () => {
    const taskId = seedReviewableTask()
    verifyWorktreeForTask.mockImplementation(async () => {
      setWorktree(taskId, null, null)
      return { ok: true }
    })

    const result = await startPlanAudit(taskId)

    expect(result).toMatchObject({ ok: false, reasonCode: 'worktree_not_verified' })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('refuses when the task LEAVES awaiting_plan_review in the gap', async () => {
    const taskId = seedReviewableTask()
    verifyWorktreeForTask.mockImplementation(async () => {
      repository
        .getDatabase()
        .prepare(`UPDATE audited_tasks SET state = 'planning' WHERE id = ?`)
        .run(taskId)
      return { ok: true }
    })

    const result = await startPlanAudit(taskId)

    expect(result).toMatchObject({ ok: false, reasonCode: 'illegal_transition' })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('spawns with the CURRENT persisted cwd on a normal admission', async () => {
    const taskId = seedReviewableTask()

    const result = await startPlanAudit(taskId)

    expect(result).toEqual({ ok: true })
    expect(codexRunner).toHaveBeenCalledTimes(1)
    expect(codexRunner.mock.calls[0]![0].worktreePath).toBe(ORIGINAL_WORKTREE)
    expect(codexRunner.mock.calls[0]![0].worktreePath).not.toBe(MOVED_WORKTREE)
  })

  it('leaves transition history untouched when the identity changed', async () => {
    const taskId = seedReviewableTask()
    const before = transitionCount(taskId)
    verifyWorktreeForTask.mockImplementation(async () => {
      setWorktree(taskId, MOVED_WORKTREE, 'audited/1')
      return { ok: true }
    })

    await startPlanAudit(taskId)

    expect(transitionCount(taskId)).toBe(before)
    expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
  })
})

describe('resolveAcceptanceCriteria', () => {
  it('returns the persisted criteria from the succeeded triage run', () => {
    const taskId = seedReviewableTask()
    expect(resolveAcceptanceCriteria(repository.getDatabase(), taskId)).toEqual({
      ok: true,
      criteria: CRITERIA
    })
  })

  it.each([
    ['no triage row at all', undefined],
    ['a null column', null],
    ['a blank column', '   '],
    ['malformed JSON', '{not json'],
    ['an empty array', '[]'],
    ['a non-array', '{"id":"a"}'],
    ['a missing text field', '[{"id":"a","covered":false}]'],
    ['a blank text field', '[{"id":"a","text":"  ","covered":false}]'],
    ['an extra key', '[{"id":"a","text":"t","covered":false,"evil":1}]'],
    ['a wrong-typed covered', '[{"id":"a","text":"t","covered":"no"}]']
  ])('fails closed on %s', (_label, json) => {
    const taskId =
      json === undefined ? seedReviewableTaskWithoutTriage() : seedReviewableTask(json as string)
    expect(resolveAcceptanceCriteria(repository.getDatabase(), taskId)).toEqual({
      ok: false,
      reasonCode: 'acceptance_criteria_unavailable'
    })
  })

  it('ignores a BLOCKED triage run and uses only succeeded ones', () => {
    const taskId = seedReviewableTaskWithoutTriage()
    repository
      .getDatabase()
      .prepare(
        `INSERT INTO audited_triage_runs
           (id, task_id, status, acceptance_criteria_json, started_at_ms, ended_at_ms)
         VALUES ('t_blocked', ?, 'blocked', ?, 1, 2)`
      )
      .run(taskId, JSON.stringify(CRITERIA))

    expect(resolveAcceptanceCriteria(repository.getDatabase(), taskId)).toMatchObject({
      ok: false
    })
  })
})

describe('acceptance criteria reach the Codex prompt', () => {
  it('embeds the EXACT persisted criteria', async () => {
    const taskId = seedReviewableTask()

    await startPlanAudit(taskId)

    const prompt = codexRunner.mock.calls[0]![0].prompt as string
    for (const criterion of CRITERIA) {
      expect(prompt).toContain(criterion.text)
    }
    // And no longer claims there are none.
    expect(prompt).not.toContain('(none recorded)')
  })

  it('creates NO run and calls NO runner when criteria are missing', async () => {
    const taskId = seedReviewableTaskWithoutTriage()

    const result = await startPlanAudit(taskId)

    expect(result).toEqual({
      ok: false,
      kind: 'planReview',
      reasonCode: 'acceptance_criteria_unavailable'
    })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('creates NO run and calls NO runner when criteria are malformed', async () => {
    const taskId = seedReviewableTask('[{"id":"a"}]')

    const result = await startPlanAudit(taskId)

    expect(result).toMatchObject({ ok: false, reasonCode: 'acceptance_criteria_unavailable' })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('leaves task state and transition history unchanged on a criteria failure', async () => {
    const taskId = seedReviewableTaskWithoutTriage()
    const before = transitionCount(taskId)

    await startPlanAudit(taskId)

    expect(transitionCount(taskId)).toBe(before)
    expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
  })
})

/** Same as seedReviewableTask but with NO triage run row at all. */
function seedReviewableTaskWithoutTriage(): string {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = ?, branch_name = 'audited/1',
         worktree_provenance = 'orca_audited_v1', worktree_verified_at_ms = 1 WHERE id = ?`
    )
    .run(ORIGINAL_WORKTREE, taskId)
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    {
      taskId,
      runId,
      round: 0,
      rawPlanText: 'A plan body.',
      sanitizationContext: {},
      counters: COUNTERS
    },
    1_000
  )
  if (!derived.ok) {
    throw new Error('seed failed')
  }
  return taskId
}
