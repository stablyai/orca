// REVIEW-SUMMARY LEAKAGE.
//
// planReviewSummary is the ONE free-text field on the projection. It is
// model-authored, and Codex runs with the audited worktree as its working root
// and can read the repository — so its summary can quote an absolute path or the
// audited branch name verbatim.
//
// These tests follow that text along the whole path it actually travels:
// persisted row -> projection -> IPC result -> renderer prop. It must be
// redacted at the FIRST of those (before storage), because every later consumer
// reads the stored value.
import { mkdtempSync, rmSync } from 'node:fs'
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

import { AuditedTaskRepository } from './audited-task-repository'
import { getTaskProjection, setAuditedTaskRepositoryForTests } from './audited-task-service'
import { derivePlanArtifact } from './audited-plan-artifact-derivation'
import { getCurrentPlanArtifact } from './audited-plan-artifact-repository'
import { setAuditedCodexRunnerForTests } from './audited-plan-audit-launcher'
import { startPlanAudit } from './audited-plan-review-orchestration'
import { getLatestPlanReviewRun } from './audited-plan-review-run-repository'
import { seedTriagedTask, startRun } from './audited-execution-test-fixtures'
import { MAX_COVERAGE_NOTE_CHARS } from '../../shared/audited-plan-artifact-types'

let repository: AuditedTaskRepository

const COUNTERS = { stdoutBytes: 1, stderrBytes: 0, outputTruncated: false, exitCode: 0 }

// The identity values a real deployment would have. Chosen so a naive
// implementation leaks them.
const WORKTREE_PATH = 'C:\\Users\\alice\\orca\\worktrees\\audited-task-1'
const SOURCE_REPO = 'C:\\Users\\alice\\orca'
const COMMON_DIR = 'C:\\Users\\alice\\orca\\.git'
const BRANCH = 'audited/task-1-secret-feature'

// One summary quoting BOTH separator conventions plus the branch name, which is
// exactly what a model that ran shell commands would produce.
const LEAKY_SUMMARY = [
  `The plan edits ${WORKTREE_PATH}\\src\\index.ts`,
  `and also C:/Users/alice/orca/worktrees/audited-task-1/src/other.ts.`,
  `It targets branch ${BRANCH} in ${SOURCE_REPO}.`,
  `Git metadata lives at ${COMMON_DIR}.`,
  `On the CI box the same tree is /home/runner/orca/checkout.`
].join(' ')

const LEAKY_SUBSTRINGS = [
  'alice',
  WORKTREE_PATH,
  SOURCE_REPO,
  COMMON_DIR,
  BRANCH,
  'C:/Users/alice',
  '/home/runner'
]

function makeTask(): string {
  return repository.createTask({
    repoId: 'repo1',
    sourceRepoPath: SOURCE_REPO,
    baseCommit: 'a'.repeat(40),
    hostId: 'local',
    title: 'T',
    spec: { title: 'T', description: '' },
    source: 'custom',
    risk: 'low'
  }).id
}

function seedReviewableTask(): string {
  const taskId = makeTask()
  seedTriagedTask(repository, taskId, 'plan')
  repository
    .getDatabase()
    .prepare(
      `UPDATE audited_tasks SET worktree_path = ?, branch_name = ?, source_repo_common_dir = ?,
         worktree_provenance = 'orca_audited_v1', worktree_verified_at_ms = 1 WHERE id = ?`
    )
    .run(WORKTREE_PATH, BRANCH, COMMON_DIR, taskId)
  const runId = startRun(repository, taskId, 'plan')
  const derived = derivePlanArtifact(
    repository.getDatabase(),
    userData,
    {
      taskId,
      runId,
      round: 0,
      rawPlanText: 'A safe plan body.',
      sanitizationContext: {},
      counters: COUNTERS
    },
    1_000
  )
  if (!derived.ok) {
    throw new Error('seed failed')
  }
  seedTriageCriteria(taskId)
  // Sanity: the artifact exists and is current.
  getCurrentPlanArtifact(repository.getDatabase(), taskId)
  return taskId
}

/** Drives a full audit whose Codex reply carries the leaky summary. */
async function runAuditWithSummary(taskId: string, summary: string): Promise<void> {
  setAuditedCodexRunnerForTests(async (args) => {
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(args.lastMessagePath, '..'), { recursive: true })
    writeFileSync(
      args.lastMessagePath,
      JSON.stringify({ verdict: 'fixes_requested', summary, findings: [{ text: 'x' }] }),
      'utf8'
    )
    return { kind: 'exit', exitCode: 0, stdout: 'banner', stderr: '' }
  })
  await startPlanAudit(taskId)
}

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'orca-summary-'))
  repository = new AuditedTaskRepository(':memory:')
  setAuditedTaskRepositoryForTests(repository)
  verifyWorktreeForTask.mockResolvedValue({ ok: true })
})

afterEach(() => {
  setAuditedCodexRunnerForTests(undefined)
  setAuditedTaskRepositoryForTests(undefined)
  repository.close()
  rmSync(userData, { recursive: true, force: true })
})

describe('review summary redaction along the full path', () => {
  it('redacts every identity value in the PERSISTED row', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithSummary(taskId, LEAKY_SUMMARY)

    const run = getLatestPlanReviewRun(repository.getDatabase(), taskId)!
    expect(run.summary).not.toBeNull()
    for (const leak of LEAKY_SUBSTRINGS) {
      expect(run.summary).not.toContain(leak)
    }
  })

  it('redacts every identity value on the PROJECTION', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithSummary(taskId, LEAKY_SUMMARY)

    const projection = getTaskProjection(taskId)!
    expect(projection.planReviewSummary).not.toBeNull()
    for (const leak of LEAKY_SUBSTRINGS) {
      expect(projection.planReviewSummary).not.toContain(leak)
    }
  })

  it('leaks nothing through the WHOLE serialized projection', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithSummary(taskId, LEAKY_SUMMARY)

    // The projection is what crosses IPC and becomes renderer props verbatim,
    // so serializing it covers all three of those boundaries at once.
    const serialized = JSON.stringify(getTaskProjection(taskId))
    for (const leak of LEAKY_SUBSTRINGS) {
      expect(serialized).not.toContain(leak)
    }
  })

  it('keeps the summary useful: non-identity prose survives', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithSummary(
      taskId,
      `The plan misses error handling in ${WORKTREE_PATH}\\src\\a.ts and needs a test.`
    )

    const projection = getTaskProjection(taskId)!
    expect(projection.planReviewSummary).toContain('misses error handling')
    expect(projection.planReviewSummary).toContain('needs a test')
    expect(projection.planReviewSummary).not.toContain('alice')
  })

  it('redacts a POSIX-style repo path quoted by the model', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithSummary(taskId, 'See /Users/alice/orca/src/index.ts for the change.')

    const projection = getTaskProjection(taskId)!
    expect(projection.planReviewSummary).not.toContain('/Users/alice')
  })

  it('redacts a credential the model echoed into its summary', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithSummary(taskId, 'The plan hardcodes sk-abcdefghijklmnopqrstuvwxyz012345.')

    const projection = getTaskProjection(taskId)!
    expect(projection.planReviewSummary).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })
})

// R16. A coverage NOTE is the second piece of model-authored free text to reach
// the renderer, and it travels the same path as the summary — so it gets the same
// treatment at the same point: redacted BEFORE storage, never on the way out.
describe('coverage note redaction along the full path', () => {
  /** Drives a full audit whose reply carries a leaky note on criterion ac1. */
  async function runAuditWithNote(taskId: string, note: string): Promise<void> {
    setAuditedCodexRunnerForTests(async (args) => {
      const { writeFileSync, mkdirSync } = await import('node:fs')
      mkdirSync(join(args.lastMessagePath, '..'), { recursive: true })
      writeFileSync(
        args.lastMessagePath,
        JSON.stringify({
          verdict: 'fixes_requested',
          summary: 'A safe summary.',
          coverage: [{ id: 'ac1', covered: true, note }]
        }),
        'utf8'
      )
      return { kind: 'exit', exitCode: 0, stdout: 'banner', stderr: '' }
    })
    await startPlanAudit(taskId)
  }

  function storedNote(taskId: string): string | null {
    const row = repository
      .getDatabase()
      .prepare(`SELECT note FROM audited_plan_coverage WHERE task_id = ? AND criterion_id = 'ac1'`)
      .get(taskId) as { note: string | null } | undefined
    return row?.note ?? null
  }

  it('redacts every identity value in the PERSISTED note', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithNote(taskId, LEAKY_SUMMARY)

    const note = storedNote(taskId)
    expect(note).not.toBeNull()
    for (const leak of LEAKY_SUBSTRINGS) {
      expect(note, `stored note must not contain "${leak}"`).not.toContain(leak)
    }
  })

  it('redacts the note on the PROJECTION the renderer receives', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithNote(taskId, LEAKY_SUMMARY)

    const criterion = getTaskProjection(taskId)!.acceptanceCriteria.find((c) => c.id === 'ac1')
    expect(criterion?.note).toBeDefined()
    for (const leak of LEAKY_SUBSTRINGS) {
      expect(criterion?.note, `projected note must not contain "${leak}"`).not.toContain(leak)
    }
  })

  it('redacts a credential the model echoed into a note', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithNote(taskId, 'Covered by sk-abcdefghijklmnopqrstuvwxyz012345.')

    expect(storedNote(taskId)).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
  })

  // The cap is applied AFTER redaction: truncating first could sever a path
  // mid-token and leave the head of it behind.
  it('bounds the stored note length', async () => {
    const taskId = seedReviewableTask()
    await runAuditWithNote(taskId, 'x'.repeat(500))

    expect(storedNote(taskId)!.length).toBeLessThanOrEqual(MAX_COVERAGE_NOTE_CHARS)
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
