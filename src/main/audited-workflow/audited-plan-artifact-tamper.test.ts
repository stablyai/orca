// THE REVIEWED BYTES ARE BOUND TO THE ARTIFACT HASH.
//
// The artifact row's content_sha256 is the identity every downstream
// authorization hangs off — the admission CAS, the finalize freshness check, and
// approvePlan all compare against it. Before this binding, the row only ever
// DESCRIBED the file; nothing re-verified that the file still matched. An edited
// plan.md would have been reviewed by Codex, or shown to the human, while all
// the hash-based guards still agreed.
//
// These tests prove a tampered file: (1) never reaches a Codex spawn, (2) never
// yields a verdict that can authorize approval, and (3) never crosses IPC.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userData: string

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: vi.fn(() => userData) }
}))

const verifyWorktreeForTask = vi.fn(async () => ({ ok: true }) as { ok: true })
vi.mock('./audited-worktree-service', () => ({
  verifyWorktreeForTask: (...args: unknown[]) => verifyWorktreeForTask(...(args as [])),
  ensureWorktreeForTask: vi.fn(),
  setAuditedWorktreeStore: vi.fn(),
  rebuildAuditedWorktreeRegistry: vi.fn(),
  reconcileAuditedWorktreesOnStartup: vi.fn(),
  recoverWorktreeForTask: vi.fn()
}))

// The spawn seam. If a tampered artifact ever reaches a launch, this records it.
const codexRunner = vi.fn()

import { AuditedTaskRepository } from './audited-task-repository'
import { setAuditedTaskRepositoryForTests } from './audited-task-service'
import { derivePlanArtifact } from './audited-plan-artifact-derivation'
import { getCurrentPlanArtifact } from './audited-plan-artifact-repository'
import {
  getPlanArtifactFilePath,
  readVerifiedPlanArtifact,
  writePlanArtifactFileForTests
} from './audited-plan-artifact-store'
import { setAuditedCodexRunnerForTests } from './audited-plan-audit-launcher'
import { startPlanAudit } from './audited-plan-review-orchestration'
import { hasApprovedVerdictForCurrentArtifact } from './audited-plan-review-run-repository'
import { seedTriagedTask, startRun } from './audited-execution-test-fixtures'

let repository: AuditedTaskRepository

const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }
const PLAN_BODY = '1. Add a guard.\n2. Add a test.'

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

/** A task in awaiting_plan_review with one current artifact and a worktree. */
function seedReviewableTask(): { taskId: string; artifactId: string; sha: string } {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = ?, branch_name = 'audited/t',
         worktree_provenance = 'orca_audited_v1', worktree_verified_at_ms = 1 WHERE id = ?`
    )
    .run(join(userData, 'wt'), taskId)
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    {
      taskId,
      runId,
      round: 0,
      rawPlanText: PLAN_BODY,
      sanitizationContext: {},
      counters: COUNTERS
    },
    1_000
  )
  if (!derived.ok) {
    throw new Error('seed failed')
  }
  seedTriageCriteria(taskId)
  const artifact = getCurrentPlanArtifact(repository.getDatabase(), taskId)!
  return { taskId, artifactId: artifact.id, sha: artifact.contentSha256 }
}

/** Rewrites the artifact body on disk WITHOUT touching its row. */
function tamperArtifact(artifactId: string, body: string): void {
  writePlanArtifactFileForTests(userData, artifactId, body)
}

function reviewRunCount(taskId: string): number {
  const row = repository
    .getDatabase()
    .prepare(`SELECT COUNT(*) as n FROM audited_plan_review_runs WHERE task_id = ?`)
    .get(taskId) as { n: number }
  return row.n
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-tamper-'))
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  codexRunner.mockReset()
  codexRunner.mockResolvedValue({ kind: 'exit', exitCode: 0, stdout: '', stderr: '' })
  setAuditedCodexRunnerForTests(codexRunner)
  verifyWorktreeForTask.mockResolvedValue({ ok: true })
})

afterEach(() => {
  setAuditedCodexRunnerForTests(undefined)
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('readVerifiedPlanArtifact', () => {
  it('returns the body when the bytes match the recorded hash', () => {
    const { artifactId, sha } = seedReviewableTask()
    expect(readVerifiedPlanArtifact(userData, artifactId, sha)).toEqual({
      ok: true,
      text: PLAN_BODY
    })
  })

  it('reports artifact_superseded when the file was edited', () => {
    const { artifactId, sha } = seedReviewableTask()
    tamperArtifact(artifactId, '1. rm -rf /\n')
    expect(readVerifiedPlanArtifact(userData, artifactId, sha)).toEqual({
      ok: false,
      reasonCode: 'artifact_superseded'
    })
  })

  it('detects a single-character edit', () => {
    const { artifactId, sha } = seedReviewableTask()
    tamperArtifact(artifactId, `${PLAN_BODY} `)
    expect(readVerifiedPlanArtifact(userData, artifactId, sha)).toMatchObject({ ok: false })
  })

  it('reports artifact_unavailable when the file is gone', () => {
    const { artifactId, sha } = seedReviewableTask()
    rmSync(getPlanArtifactFilePath(userData, artifactId), { force: true })
    expect(readVerifiedPlanArtifact(userData, artifactId, sha)).toEqual({
      ok: false,
      reasonCode: 'artifact_unavailable'
    })
  })

  it('reports artifact_unavailable when the file exceeds the read cap', () => {
    const { artifactId, sha } = seedReviewableTask()
    writeFileSync(
      getPlanArtifactFilePath(userData, artifactId),
      'x'.repeat(1024 * 1024 * 2),
      'utf8'
    )
    expect(readVerifiedPlanArtifact(userData, artifactId, sha)).toEqual({
      ok: false,
      reasonCode: 'artifact_unavailable'
    })
  })
})

describe('startPlanAudit with a tampered artifact', () => {
  it('SPAWNS NOTHING and creates no review row', async () => {
    const { taskId, artifactId } = seedReviewableTask()
    tamperArtifact(artifactId, 'A completely different plan.')

    const result = await startPlanAudit(taskId)

    expect(result).toEqual({
      ok: false,
      kind: 'planReview',
      reasonCode: 'artifact_superseded'
    })
    // The two properties that matter most.
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('leaves the task unable to be approved', async () => {
    const { taskId, artifactId } = seedReviewableTask()
    tamperArtifact(artifactId, 'A completely different plan.')

    await startPlanAudit(taskId)

    // No verdict exists, so nothing can authorize implementation.
    expect(hasApprovedVerdictForCurrentArtifact(repository.getDatabase(), taskId)).toBe(false)
    expect(repository.getTask(taskId)!.state).toBe('awaiting_plan_review')
  })

  it('spawns nothing when the artifact file was deleted', async () => {
    const { taskId, artifactId } = seedReviewableTask()
    rmSync(getPlanArtifactFilePath(userData, artifactId), { force: true })

    const result = await startPlanAudit(taskId)

    expect(result).toMatchObject({ ok: false, reasonCode: 'artifact_unavailable' })
    expect(codexRunner).not.toHaveBeenCalled()
    expect(reviewRunCount(taskId)).toBe(0)
  })

  it('does spawn for an untampered artifact, and audits the exact bytes', async () => {
    const { taskId } = seedReviewableTask()

    await startPlanAudit(taskId)

    expect(codexRunner).toHaveBeenCalledTimes(1)
    // The prompt embeds the VERIFIED text, not a re-read.
    const prompt = codexRunner.mock.calls[0]![0].prompt as string
    expect(prompt).toContain(PLAN_BODY)
  })

  it('verifies BEFORE the worktree check cannot mask it: tampering wins either way', async () => {
    const { taskId, artifactId } = seedReviewableTask()
    tamperArtifact(artifactId, 'tampered')
    verifyWorktreeForTask.mockResolvedValue({ ok: true })

    await startPlanAudit(taskId)
    expect(codexRunner).not.toHaveBeenCalled()
  })
})

/**
 * The succeeded triage run whose acceptance criteria the audit judges against.
 * startPlanAudit refuses to run without them, so every reviewable fixture needs
 * one — matching a real task, which always reaches this state via triage.
 */
function seedTriageCriteria(taskId: string): void {
  repository
    .getDatabase()
    .prepare(
      `INSERT INTO audited_triage_runs
         (id, task_id, status, decision, acceptance_criteria_json, next_step_prompt,
          started_at_ms, ended_at_ms)
       VALUES (?, ?, 'succeeded', 'plan', ?, 'go', 1, 2)`
    )
    .run(
      `triage_${taskId}`,
      taskId,
      JSON.stringify([{ id: 'ac1', text: 'It works.', covered: false }])
    )
}
