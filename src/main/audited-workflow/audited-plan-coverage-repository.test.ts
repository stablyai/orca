// Phase 6 read authority: WHICH run's coverage describes the current plan.
//
// The four bindings (succeeded run, artifact still current, artifact is the
// task's pointer, hash still matches) describe the ARTIFACT, so SEVERAL runs can
// satisfy them at once. Resolving exactly one run before reading rows is what
// keeps the result single-valued — see the fan-out test below, which is the
// regression a join-and-ORDER-BY implementation fails.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => '/tmp/userData') }
}))

import { AuditedTaskRepository } from './audited-task-repository'
import { getCurrentCoverage, insertCoverageRows } from './audited-plan-coverage-repository'

let repository: AuditedTaskRepository

const TASK_ID = 'task_1'
const ARTIFACT_ID = 'plan_a'
const SHA = 'a'.repeat(64)

function db() {
  return repository.getDatabase()
}

/** A task pointing at one 'current' artifact. */
function seed(): void {
  db()
    .prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source, risk,
          state, plan_round, fix_round, current_plan_artifact_id, created_at_ms, updated_at_ms)
       VALUES (?, 'r', '/p', 'abc', 'local', 'T', '{}', 'custom', 'low',
               'awaiting_plan_review', 0, 0, ?, 1, 1)`
    )
    .run(TASK_ID, ARTIFACT_ID)
  db()
    .prepare(
      `INSERT INTO audited_plan_artifacts
         (id, task_id, run_id, round, status, content_sha256, char_count, truncated,
          redaction_count, created_at_ms)
       VALUES (?, ?, 'exec_1', 0, 'current', ?, 10, 0, 0, 1)`
    )
    .run(ARTIFACT_ID, TASK_ID, SHA)
}

/** A review run bound to the seeded artifact, with an explicit start time. */
function seedRun(
  runId: string,
  options: { status?: string; startedAt?: number; sha?: string; artifactId?: string } = {}
): string {
  db()
    .prepare(
      `INSERT INTO audited_plan_review_runs
         (id, task_id, artifact_id, artifact_sha256, round, status, verdict,
          worktree_verified_at_ms, started_at_ms, ended_at_ms)
       VALUES (?, ?, ?, ?, 0, ?, 'approved', 1, ?, 2)`
    )
    .run(
      runId,
      TASK_ID,
      options.artifactId ?? ARTIFACT_ID,
      options.sha ?? SHA,
      options.status ?? 'succeeded',
      options.startedAt ?? 1_000
    )
  return runId
}

function insert(
  runId: string,
  ...rows: { criterionId: string; covered: boolean; note?: string }[]
): void {
  insertCoverageRows(
    db(),
    {
      runId,
      taskId: TASK_ID,
      coverage: rows.map((row) => ({
        criterionId: row.criterionId,
        covered: row.covered,
        note: row.note ?? null
      }))
    },
    1
  )
}

beforeEach(() => {
  repository = new AuditedTaskRepository(':memory:')
  seed()
})

afterEach(() => {
  repository.close()
})

describe('getCurrentCoverage', () => {
  it('returns the rows of a qualifying run', () => {
    const runId = seedRun('rev_1')
    insert(
      runId,
      { criterionId: 'ac1', covered: true, note: 'why' },
      { criterionId: 'ac2', covered: false }
    )

    const result = getCurrentCoverage(db(), TASK_ID)

    expect(result.available).toBe(true)
    expect(result.byCriterionId.get('ac1')).toEqual({ covered: true, note: 'why' })
    expect(result.byCriterionId.get('ac2')).toEqual({ covered: false, note: null })
  })

  // R10c. Availability and the map are one snapshot; they can never disagree.
  it('reports unavailable with an empty map when no run qualifies', () => {
    const result = getCurrentCoverage(db(), TASK_ID)
    expect(result).toEqual({ available: false, byCriterionId: new Map() })
  })

  // R10b — THE FAN-OUT REGRESSION. Two succeeded runs both satisfy all four
  // bindings, because the bindings describe the artifact and the plan never
  // changed (a retry after a transient failure). A single filtered join would
  // match BOTH runs' rows and merge them; resolving one run first cannot.
  it('uses only the NEWEST run when several qualify for the same artifact', () => {
    const older = seedRun('rev_old', { startedAt: 1_000 })
    insert(
      older,
      { criterionId: 'ac1', covered: false, note: 'stale' },
      { criterionId: 'ac2', covered: false, note: 'stale' }
    )
    const newer = seedRun('rev_new', { startedAt: 2_000 })
    insert(
      newer,
      { criterionId: 'ac1', covered: true, note: 'fresh' },
      { criterionId: 'ac2', covered: true, note: 'fresh' }
    )

    const result = getCurrentCoverage(db(), TASK_ID)

    // Exactly one entry per criterion — not four, and not a merge of the two.
    expect(result.byCriterionId.size).toBe(2)
    expect(result.byCriterionId.get('ac1')).toEqual({ covered: true, note: 'fresh' })
    expect(result.byCriterionId.get('ac2')).toEqual({ covered: true, note: 'fresh' })
    expect([...result.byCriterionId.values()].some((v) => v.note === 'stale')).toBe(false)
  })

  // R10. Ordering across three runs, including one that started between them.
  it('prefers the latest started run across three', () => {
    insert(seedRun('rev_1', { startedAt: 1_000 }), {
      criterionId: 'ac1',
      covered: false,
      note: 'first'
    })
    insert(seedRun('rev_3', { startedAt: 3_000 }), {
      criterionId: 'ac1',
      covered: true,
      note: 'third'
    })
    insert(seedRun('rev_2', { startedAt: 2_000 }), {
      criterionId: 'ac1',
      covered: false,
      note: 'second'
    })

    expect(getCurrentCoverage(db(), TASK_ID).byCriterionId.get('ac1')).toEqual({
      covered: true,
      note: 'third'
    })
  })

  // R11 / tampering. Each of these is a row that EXISTS but must not be believed.
  it('ignores a run that did not succeed', () => {
    insert(seedRun('rev_1', { status: 'failed' }), { criterionId: 'ac1', covered: true })
    expect(getCurrentCoverage(db(), TASK_ID).available).toBe(false)
  })

  it('ignores a run whose hash no longer matches the artifact', () => {
    insert(seedRun('rev_1', { sha: 'b'.repeat(64) }), { criterionId: 'ac1', covered: true })
    expect(getCurrentCoverage(db(), TASK_ID).available).toBe(false)
  })

  // R9. Supersession needs no invalidation step: the joins simply stop matching.
  it('goes unavailable when the plan is revised, without touching the rows', () => {
    const runId = seedRun('rev_1')
    insert(runId, { criterionId: 'ac1', covered: true })
    expect(getCurrentCoverage(db(), TASK_ID).available).toBe(true)

    // A revision supersedes the artifact and repoints the task.
    db()
      .prepare(`UPDATE audited_plan_artifacts SET status = 'superseded' WHERE id = ?`)
      .run(ARTIFACT_ID)
    db()
      .prepare(`UPDATE audited_tasks SET current_plan_artifact_id = 'plan_b' WHERE id = ?`)
      .run(TASK_ID)

    expect(getCurrentCoverage(db(), TASK_ID).available).toBe(false)
    // The history survives untouched — it is immutable evidence of a real audit.
    const surviving = db()
      .prepare(`SELECT COUNT(*) as n FROM audited_plan_coverage WHERE run_id = ?`)
      .get(runId) as { n: number }
    expect(surviving.n).toBe(1)
  })

  it('ignores a run bound to an artifact that is not the task pointer', () => {
    db()
      .prepare(
        `INSERT INTO audited_plan_artifacts
           (id, task_id, run_id, round, status, content_sha256, char_count, truncated,
            redaction_count, created_at_ms)
         VALUES ('plan_other', ?, 'exec_2', 1, 'superseded', ?, 10, 0, 0, 1)`
      )
      .run(TASK_ID, SHA)
    insert(seedRun('rev_1', { artifactId: 'plan_other' }), { criterionId: 'ac1', covered: true })

    expect(getCurrentCoverage(db(), TASK_ID).available).toBe(false)
  })

  it('reports available with an empty map when a qualifying run recorded no rows', () => {
    seedRun('rev_1')
    const result = getCurrentCoverage(db(), TASK_ID)
    // An audit ran; it just had no criteria to judge. Distinct from "not audited".
    expect(result.available).toBe(true)
    expect(result.byCriterionId.size).toBe(0)
  })
})

describe('insertCoverageRows', () => {
  it('rejects a duplicate criterion for the same run', () => {
    const runId = seedRun('rev_1')
    insert(runId, { criterionId: 'ac1', covered: true })
    expect(() => insert(runId, { criterionId: 'ac1', covered: false })).toThrow()
  })

  it('allows the same criterion under a different run', () => {
    insert(seedRun('rev_1', { startedAt: 1_000 }), { criterionId: 'ac1', covered: true })
    expect(() =>
      insert(seedRun('rev_2', { startedAt: 2_000 }), { criterionId: 'ac1', covered: false })
    ).not.toThrow()
  })
})
