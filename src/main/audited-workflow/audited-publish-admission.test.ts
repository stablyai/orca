// Phase 9 admission — THE PHASE 8 BINDING and the guards around it.
//
// The central property: a publish may be authorized ONLY for a `completed`
// commit attempt whose created_commit_sha exactly equals committed_sha. Every
// refusal below inserts NO attempt row, so no network command can follow.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuditedWorkflowTables } from './audited-task-schema'
import {
  authorizePublishAttempt,
  getLatestPublishAttempt,
  resolvePublishableCommitAttempt
} from './audited-publish-attempt-repository'
import Database from '../sqlite/sync-database'

const SHA = 'c'.repeat(40)
const OTHER_SHA = 'd'.repeat(40)
const BASE = 'b'.repeat(40)
const NOW = 2_000_000

type SeedOptions = {
  state?: string
  committedSha?: string | null
  commitStatus?: string
  createdCommitSha?: string | null
  hostId?: string
  wslDistro?: string | null
  worktreeReasonCode?: string | null
  branchName?: string
}

function seed(db: Database.Database, options: SeedOptions = {}): void {
  db.prepare(
    `INSERT INTO audited_tasks
       (id, repo_id, source_repo_path, base_commit, host_id, wsl_distro, title, spec_json,
        source, risk, state, branch_name, worktree_path, worktree_verified_at_ms,
        worktree_reason_code, committed_sha, created_at_ms, updated_at_ms)
     VALUES ('task1', 'repo1', '/repo', ?, ?, ?, 't', '{}', 'custom', 'low', ?, ?,
             '/wt', 500, ?, ?, 1, 1)`
  ).run(
    BASE,
    options.hostId ?? 'local',
    options.wslDistro ?? null,
    options.state ?? 'committed',
    options.branchName ?? 'feature',
    options.worktreeReasonCode ?? null,
    options.committedSha === undefined ? SHA : options.committedSha
  )
  db.prepare(
    `INSERT INTO audited_commit_attempts
       (id, task_id, approval_id, intended_tree_oid, intended_parent, intended_branch,
        intended_message_sha, status, created_commit_sha, authorized_at_ms)
     VALUES ('catt_1', 'task1', 'appr_1', ?, ?, 'feature', 'msg', ?, ?, 10)`
  ).run(
    'a'.repeat(40),
    BASE,
    options.commitStatus ?? 'completed',
    options.createdCommitSha === undefined ? SHA : options.createdCommitSha
  )
}

function authorize(
  db: Database.Database,
  overrides: Partial<{ sha: string; branch: string }> = {}
) {
  return authorizePublishAttempt(
    db,
    {
      taskId: 'task1',
      commitAttemptId: 'catt_1',
      intendedSha: overrides.sha ?? SHA,
      intendedBranch: overrides.branch ?? 'feature',
      intendedRemote: 'origin',
      expectedWorktreePath: '/wt',
      expectedWorktreeVerifiedAt: 500
    },
    NOW
  )
}

describe('publish admission — the Phase 8 binding', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
  })

  afterEach(() => {
    db.close()
  })

  it('authorizes a completed attempt bound to the exact committed sha', () => {
    seed(db)
    const result = authorize(db)
    expect(result.ok).toBe(true)
    const attempt = getLatestPublishAttempt(db, 'task1')
    expect(attempt?.status).toBe('authorized')
    expect(attempt?.intendedSha).toBe(SHA)
  })

  it('KEEPS the task in committed when authorizing', () => {
    seed(db)
    authorize(db)
    const row = db.prepare(`SELECT state FROM audited_tasks WHERE id = 'task1'`).get() as {
      state: string
    }
    expect(row.state).toBe('committed')
  })

  it('refuses when the commit attempt is not completed', () => {
    seed(db, { commitStatus: 'failed_no_effect' })
    expect(authorize(db)).toEqual({ ok: false, reasonCode: 'commit_attempt_not_completed' })
    expect(getLatestPublishAttempt(db, 'task1')).toBeNull()
  })

  it('refuses when the completed attempt names a DIFFERENT sha', () => {
    // The decisive binding case: status is right, sha is not.
    seed(db, { createdCommitSha: OTHER_SHA })
    expect(authorize(db)).toEqual({ ok: false, reasonCode: 'commit_attempt_not_completed' })
    expect(getLatestPublishAttempt(db, 'task1')).toBeNull()
  })

  it('refuses when the caller names a sha other than committed_sha', () => {
    seed(db)
    expect(authorize(db, { sha: OTHER_SHA })).toEqual({
      ok: false,
      reasonCode: 'commit_attempt_sha_mismatch'
    })
    expect(getLatestPublishAttempt(db, 'task1')).toBeNull()
  })

  it.each([
    ['selected'],
    ['implementing'],
    ['awaiting_human_approval'],
    ['committing'],
    ['blocked']
  ])('refuses from the non-committed state %s', (state) => {
    seed(db, { state })
    expect(authorize(db)).toEqual({ ok: false, reasonCode: 'task_not_committed' })
    expect(getLatestPublishAttempt(db, 'task1')).toBeNull()
  })

  it('refuses when committed_sha is missing', () => {
    seed(db, { committedSha: null })
    expect(authorize(db)).toEqual({ ok: false, reasonCode: 'committed_sha_missing' })
  })

  it.each([
    ['wsl', { wslDistro: 'Ubuntu' }],
    ['ssh', { hostId: 'ssh-1' }]
  ])('refuses the unsupported host %s', (_label, options) => {
    seed(db, options)
    expect(authorize(db)).toEqual({ ok: false, reasonCode: 'publish_host_unsupported' })
    expect(getLatestPublishAttempt(db, 'task1')).toBeNull()
  })

  it('refuses when the worktree identity changed', () => {
    seed(db)
    const result = authorizePublishAttempt(
      db,
      {
        taskId: 'task1',
        commitAttemptId: 'catt_1',
        intendedSha: SHA,
        intendedBranch: 'feature',
        intendedRemote: 'origin',
        expectedWorktreePath: '/wt',
        // Stale verification timestamp.
        expectedWorktreeVerifiedAt: 499
      },
      NOW
    )
    expect(result).toEqual({ ok: false, reasonCode: 'worktree_identity_changed' })
  })

  it('refuses when the worktree carries a failure reason', () => {
    seed(db, { worktreeReasonCode: 'worktree_missing' })
    expect(authorize(db)).toEqual({ ok: false, reasonCode: 'worktree_identity_changed' })
  })

  it('refuses when the branch changed under us', () => {
    seed(db, { branchName: 'other' })
    expect(authorize(db)).toEqual({ ok: false, reasonCode: 'worktree_identity_changed' })
  })

  it('admits only ONE live attempt: a second is lock_contended', () => {
    seed(db)
    expect(authorize(db).ok).toBe(true)
    expect(authorize(db)).toEqual({ ok: false, reasonCode: 'lock_contended' })
    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM audited_publish_attempts WHERE task_id = 'task1'`)
      .get() as { n: number }
    expect(count.n).toBe(1)
  })
})

describe('resolvePublishableCommitAttempt', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
  })

  afterEach(() => {
    db.close()
  })

  it('requires BOTH completed status and an exact sha match', () => {
    seed(db)
    expect(resolvePublishableCommitAttempt(db, 'task1', SHA)).toEqual({ attemptId: 'catt_1' })
    expect(resolvePublishableCommitAttempt(db, 'task1', OTHER_SHA)).toBeNull()
    expect(resolvePublishableCommitAttempt(db, 'task1', null)).toBeNull()
  })

  it('considers only the LATEST attempt, so a superseded one cannot publish', () => {
    seed(db)
    db.prepare(
      `INSERT INTO audited_commit_attempts
         (id, task_id, approval_id, intended_tree_oid, intended_parent, intended_branch,
          intended_message_sha, status, created_commit_sha, authorized_at_ms)
       VALUES ('catt_2', 'task1', 'appr_2', ?, ?, 'feature', 'msg', 'failed_no_effect', NULL, 20)`
    ).run('a'.repeat(40), BASE)
    expect(resolvePublishableCommitAttempt(db, 'task1', SHA)).toBeNull()
  })
})
