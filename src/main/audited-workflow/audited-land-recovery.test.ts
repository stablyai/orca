// Startup recovery and the read-only Recheck (Phase 10).
//
// TWO PROPERTIES THIS FILE EXISTS TO PIN:
//   1. Recovery NEVER re-runs a mutation — it reads evidence and records.
//   2. The publication gate is ADMISSION-ONLY. An attempt that reached
//      `authorized` was proven published then; a later publish failure must never
//      strand a durable, already-applied land.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuditedWorkflowTables } from './audited-task-schema'
import { getLatestLandAttempt } from './audited-land-attempt-repository'
import Database from '../sqlite/sync-database'
import type { LandEvidence } from './audited-land-evidence'

const BASE = 'b'.repeat(40)
const TARGET = 'c'.repeat(40)

let evidenceToReturn: LandEvidence

vi.mock('./audited-land-evidence', () => ({
  readLandEvidence: async () => evidenceToReturn
}))
vi.mock('./audited-task-service', () => ({
  getTaskProjection: () => null,
  getAuditedTaskRepository: () => ({ getDatabase: () => activeDb, getTask: () => null })
}))
vi.mock('./audited-workflow-broadcast', () => ({ broadcastAuditedTaskChanged: () => {} }))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/userdata' } }))

let activeDb: Database.Database

const { recoverInterruptedLandAttempts } = await import('./audited-land-run-recovery')

function seed(db: Database.Database, state = 'landing'): void {
  db.prepare(
    `INSERT INTO audited_tasks
       (id, repo_id, source_repo_path, source_repo_common_dir, base_commit, host_id, wsl_distro,
        title, spec_json, source, risk, state, branch_name, worktree_path,
        worktree_verified_at_ms, committed_sha, created_at_ms, updated_at_ms)
     VALUES ('task1', 'repo1', '/repo', '/repo/.git', ?, 'local', NULL, 't', '{}', 'custom',
             'low', ?, 'main', '/wt', 500, ?, 1, 1)`
  ).run(BASE, state, TARGET)
  db.prepare(
    `INSERT INTO audited_land_attempts
       (id, task_id, commit_attempt_id, publish_attempt_id, intended_sha, intended_branch,
        intended_base_sha, source_repo_path, source_repo_common_dir, status, authorized_at_ms)
     VALUES ('latt_1', 'task1', 'catt_1', 'patt_1', ?, 'main', ?, '/repo', '/repo/.git',
             'authorized', 10)`
  ).run(TARGET, BASE)
}

function evidence(overrides: Partial<LandEvidence> = {}): LandEvidence {
  return {
    repoIdentityIntact: true,
    branchTip: BASE,
    headCommit: false,
    committedMissingFromTip: null,
    worktreeClean: true,
    unreadable: false,
    ...overrides
  }
}

describe('startup recovery — evidence-based, never remediating', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    activeDb = db
    createAuditedWorkflowTables(db)
    seed(db)
  })

  afterEach(() => db.close())

  it('adopts a durable land and reaches the TERMINAL landed state', async () => {
    evidenceToReturn = evidence({ branchTip: TARGET, headCommit: true, worktreeClean: true })
    const recovered = await recoverInterruptedLandAttempts(db, 5_000)

    expect(recovered).toEqual([
      { taskId: 'task1', attemptId: 'latt_1', classification: 'exact_completion' }
    ])
    const attempt = getLatestLandAttempt(db, 'task1')
    expect(attempt?.status).toBe('completed')
    expect(attempt?.landedSha).toBe(TARGET)
    const row = db
      .prepare(`SELECT state, landed_sha, landing_reason_code FROM audited_tasks WHERE id='task1'`)
      .get() as { state: string; landed_sha: string; landing_reason_code: string }
    expect(row.state).toBe('landed')
    expect(row.landed_sha).toBe(TARGET)
    expect(row.landing_reason_code).toBe('landed_recovered')
  })

  it('adopts a moved ref whose worktree lagged, recording the ADVISORY', async () => {
    evidenceToReturn = evidence({ branchTip: TARGET, headCommit: false, worktreeClean: true })
    await recoverInterruptedLandAttempts(db, 5_000)

    const attempt = getLatestLandAttempt(db, 'task1')
    expect(attempt?.status).toBe('completed')
    expect(attempt?.landingAdvisory).toBe('worktree_update_failed')
    const row = db.prepare(`SELECT state FROM audited_tasks WHERE id='task1'`).get() as {
      state: string
    }
    // A worktree problem NEVER downgrades a durable land.
    expect(row.state).toBe('landed')
  })

  it('returns a no-effect attempt to committed as retryable interrupted', async () => {
    evidenceToReturn = evidence({ branchTip: BASE })
    await recoverInterruptedLandAttempts(db, 5_000)

    const attempt = getLatestLandAttempt(db, 'task1')
    expect(attempt?.status).toBe('failed_no_effect')
    expect(attempt?.reasonCode).toBe('interrupted')
    const row = db.prepare(`SELECT state FROM audited_tasks WHERE id='task1'`).get() as {
      state: string
    }
    expect(row.state).toBe('committed')
  })

  it('BLOCKS on ambiguous evidence and records the narrow block code', async () => {
    evidenceToReturn = evidence({ branchTip: 'f'.repeat(40) })
    await recoverInterruptedLandAttempts(db, 5_000)

    const attempt = getLatestLandAttempt(db, 'task1')
    expect(attempt?.status).toBe('failed_ambiguous')
    expect(attempt?.reasonCode).toBe('landing_evidence_ambiguous')
    const row = db
      .prepare(
        `SELECT state, blocked_reason_code, pre_block_state FROM audited_tasks WHERE id='task1'`
      )
      .get() as { state: string; blocked_reason_code: string; pre_block_state: string }
    expect(row.state).toBe('blocked')
    expect(row.blocked_reason_code).toBe('land_attempt_evidence_ambiguous')
    expect(row.pre_block_state).toBe('landing')
  })

  it('NEVER downgrades an attempt that is already completed', async () => {
    db.prepare(`UPDATE audited_land_attempts SET status='completed', landed_sha=? WHERE id=?`).run(
      TARGET,
      'latt_1'
    )
    evidenceToReturn = evidence({ branchTip: BASE })
    const recovered = await recoverInterruptedLandAttempts(db, 5_000)

    expect(recovered).toEqual([])
    expect(getLatestLandAttempt(db, 'task1')?.status).toBe('completed')
  })

  it('does NOT re-litigate publication: a later publish failure cannot strand a land', async () => {
    // The gate is admission-only. This attempt was proven published when
    // authorized; the publish lane has since failed, which must be irrelevant.
    db.prepare(
      `INSERT INTO audited_publish_attempts
         (id, task_id, commit_attempt_id, intended_sha, intended_branch, intended_remote,
          status, pushed_sha, authorized_at_ms)
       VALUES ('patt_2', 'task1', 'catt_1', ?, 'main', 'origin', 'failed_no_effect', NULL, 999)`
    ).run(TARGET)
    evidenceToReturn = evidence({ branchTip: TARGET, headCommit: true, worktreeClean: true })

    await recoverInterruptedLandAttempts(db, 5_000)

    const attempt = getLatestLandAttempt(db, 'task1')
    expect(attempt?.status).toBe('completed')
    const row = db.prepare(`SELECT state FROM audited_tasks WHERE id='task1'`).get() as {
      state: string
    }
    expect(row.state).toBe('landed')
  })

  it('is idempotent: a second sweep finds nothing left authorized', async () => {
    evidenceToReturn = evidence({ branchTip: TARGET, headCommit: true, worktreeClean: true })
    await recoverInterruptedLandAttempts(db, 5_000)
    const second = await recoverInterruptedLandAttempts(db, 6_000)
    expect(second).toEqual([])
  })
})

describe('landed_sha reconcile codes get their first writers', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    activeDb = db
    createAuditedWorkflowTables(db)
  })

  afterEach(() => db.close())

  it('a landed task always carries a full-OID landed_sha after adoption', async () => {
    seed(db)
    evidenceToReturn = evidence({ branchTip: TARGET, headCommit: true, worktreeClean: true })
    await recoverInterruptedLandAttempts(db, 5_000)

    const row = db.prepare(`SELECT landed_sha FROM audited_tasks WHERE id='task1'`).get() as {
      landed_sha: string | null
    }
    expect(row.landed_sha).toMatch(/^[0-9a-f]{40}$/)
  })
})
