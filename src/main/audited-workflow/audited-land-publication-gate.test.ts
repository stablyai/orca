// THE PHASE 9 PUBLICATION GATE — the lane's newest invariant, in its own file.
//
// The central property: a land may be authorized ONLY when the task's LATEST
// publish attempt is `completed` AND both its intended_sha and pushed_sha equal
// committed_sha. A local Phase 8 commit without a CONFIRMED publication must
// never reach the user's working tree.
//
// Every refusal below inserts NO attempt row and leaves the task in `committed`,
// so no Git mutation can follow.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuditedWorkflowTables } from './audited-task-schema'
import {
  authorizeLandAttempt,
  getLatestLandAttempt,
  resolveLandablePublishAttempt
} from './audited-land-attempt-repository'
import { buildAuditedTaskProjection } from '../../shared/audited-workflow-projection'
import type { ProjectionSourceTask } from '../../shared/audited-workflow-projection'
import Database from '../sqlite/sync-database'

const SHA = 'c'.repeat(40)
const OTHER_SHA = 'd'.repeat(40)
const BASE = 'b'.repeat(40)
const COMMON_DIR = '/repo/.git'
const NOW = 3_000_000

type PublishSeed = {
  status?: string
  intendedSha?: string | null
  pushedSha?: string | null
  advisory?: string | null
  id?: string
  authorizedAt?: number
}

function seedTask(db: Database.Database): void {
  db.prepare(
    `INSERT INTO audited_tasks
       (id, repo_id, source_repo_path, source_repo_common_dir, base_commit, host_id, wsl_distro,
        title, spec_json, source, risk, state, branch_name, worktree_path,
        worktree_verified_at_ms, worktree_reason_code, committed_sha, created_at_ms, updated_at_ms)
     VALUES ('task1', 'repo1', '/repo', ?, ?, 'local', NULL, 't', '{}', 'custom', 'low',
             'committed', 'feature', '/wt', 500, NULL, ?, 1, 1)`
  ).run(COMMON_DIR, BASE, SHA)
  db.prepare(
    `INSERT INTO audited_commit_attempts
       (id, task_id, approval_id, intended_tree_oid, intended_parent, intended_branch,
        intended_message_sha, status, created_commit_sha, authorized_at_ms)
     VALUES ('catt_1', 'task1', 'appr_1', ?, ?, 'feature', 'msg', 'completed', ?, 10)`
  ).run('a'.repeat(40), BASE, SHA)
}

function seedPublish(db: Database.Database, options: PublishSeed = {}): void {
  db.prepare(
    `INSERT INTO audited_publish_attempts
       (id, task_id, commit_attempt_id, intended_sha, intended_branch, intended_remote,
        status, pushed_sha, publish_advisory, authorized_at_ms)
     VALUES (?, 'task1', 'catt_1', ?, 'feature', 'origin', ?, ?, ?, ?)`
  ).run(
    options.id ?? 'patt_1',
    options.intendedSha === undefined ? SHA : options.intendedSha,
    options.status ?? 'completed',
    options.pushedSha === undefined ? SHA : options.pushedSha,
    options.advisory ?? null,
    options.authorizedAt ?? 100
  )
}

function authorize(db: Database.Database, publishAttemptId = 'patt_1') {
  return authorizeLandAttempt(
    db,
    {
      taskId: 'task1',
      commitAttemptId: 'catt_1',
      publishAttemptId,
      intendedSha: SHA,
      intendedBranch: 'feature',
      intendedBaseSha: BASE,
      sourceRepoPath: '/repo',
      sourceRepoCommonDir: COMMON_DIR,
      expectedWorktreePath: '/wt',
      expectedWorktreeVerifiedAt: 500
    },
    NOW
  )
}

function expectRefused(db: Database.Database, reasonCode: string): void {
  expect(getLatestLandAttempt(db, 'task1')).toBeNull()
  const row = db.prepare(`SELECT state FROM audited_tasks WHERE id = 'task1'`).get() as {
    state: string
  }
  expect(row.state).toBe('committed')
  expect(reasonCode).toBeTruthy()
}

describe('resolveLandablePublishAttempt — all four conditions, not any subset', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    seedTask(db)
  })

  afterEach(() => db.close())

  it('resolves when completed AND both shas equal committed_sha', () => {
    seedPublish(db)
    expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
      ok: true,
      publishAttemptId: 'patt_1'
    })
  })

  it('refuses when NO publish attempt exists', () => {
    expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
      ok: false,
      reasonCode: 'task_not_published'
    })
  })

  it.each([['failed_no_effect'], ['failed_ambiguous'], ['abandoned']])(
    'refuses a %s publish attempt',
    (status) => {
      seedPublish(db, { status, pushedSha: null })
      expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
        ok: false,
        reasonCode: 'task_not_published'
      })
    }
  )

  it('refuses while the publish outcome is UNKNOWN (authorized)', () => {
    seedPublish(db, { status: 'authorized', pushedSha: null })
    expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
      ok: false,
      reasonCode: 'publish_in_progress'
    })
  })

  it('refuses a completed attempt whose pushed_sha is NULL — never confirmed', () => {
    // The load-bearing case: status alone is not proof the remote carries it.
    seedPublish(db, { pushedSha: null })
    expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
      ok: false,
      reasonCode: 'publish_not_confirmed'
    })
  })

  it('refuses when intended_sha names a DIFFERENT commit', () => {
    seedPublish(db, { intendedSha: OTHER_SHA, pushedSha: OTHER_SHA })
    expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
      ok: false,
      reasonCode: 'publish_sha_mismatch'
    })
  })

  it('refuses when pushed_sha differs from committed_sha', () => {
    seedPublish(db, { pushedSha: OTHER_SHA })
    expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
      ok: false,
      reasonCode: 'publish_not_confirmed'
    })
  })

  it('considers only the LATEST attempt, so a superseded one cannot land', () => {
    seedPublish(db, { id: 'patt_1', authorizedAt: 100 })
    seedPublish(db, {
      id: 'patt_2',
      status: 'failed_no_effect',
      pushedSha: null,
      authorizedAt: 200
    })
    expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
      ok: false,
      reasonCode: 'task_not_published'
    })
  })

  it.each([
    ['review_request_deferred'],
    ['review_request_unsupported_provider'],
    ['review_request_auth_required'],
    ['review_request_ambiguous']
  ])('IGNORES the review advisory %s — advisories never gate landing', (advisory) => {
    seedPublish(db, { advisory })
    expect(resolveLandablePublishAttempt(db, 'task1', SHA)).toEqual({
      ok: true,
      publishAttemptId: 'patt_1'
    })
  })

  it('refuses when committed_sha is absent', () => {
    seedPublish(db)
    expect(resolveLandablePublishAttempt(db, 'task1', null)).toEqual({
      ok: false,
      reasonCode: 'committed_candidate_invalid'
    })
  })
})

describe('the gate is enforced INSIDE the admission CAS, not only at preflight', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    seedTask(db)
  })

  afterEach(() => db.close())

  it('authorizes and moves the task to `landing` when publication is confirmed', () => {
    seedPublish(db)
    const result = authorize(db)
    expect(result.ok).toBe(true)
    expect(getLatestLandAttempt(db, 'task1')?.status).toBe('authorized')
    const row = db.prepare(`SELECT state FROM audited_tasks WHERE id = 'task1'`).get() as {
      state: string
    }
    expect(row.state).toBe('landing')
  })

  it('refuses with NO attempt row when publication is missing', () => {
    const result = authorize(db)
    expect(result).toEqual({ ok: false, reasonCode: 'task_not_published' })
    expectRefused(db, 'task_not_published')
  })

  it('refuses when publication was invalidated between preflight and CAS', () => {
    // Preflight saw patt_1 completed; by admission a newer failed retry supersedes it.
    seedPublish(db, { id: 'patt_1', authorizedAt: 100 })
    seedPublish(db, {
      id: 'patt_2',
      status: 'failed_no_effect',
      pushedSha: null,
      authorizedAt: 200
    })
    const result = authorize(db, 'patt_1')
    expect(result).toEqual({ ok: false, reasonCode: 'task_not_published' })
    expectRefused(db, 'task_not_published')
  })

  it('refuses when a DIFFERENT completed attempt satisfies the sha', () => {
    // The id is compared too: a different row is still a changed world.
    seedPublish(db, { id: 'patt_2', authorizedAt: 300 })
    const result = authorize(db, 'patt_1')
    expect(result).toEqual({ ok: false, reasonCode: 'publish_sha_mismatch' })
    expectRefused(db, 'publish_sha_mismatch')
  })

  it('refuses while a publish attempt is still live', () => {
    seedPublish(db, { id: 'patt_1', authorizedAt: 100 })
    seedPublish(db, {
      id: 'patt_2',
      status: 'authorized',
      pushedSha: null,
      authorizedAt: 200
    })
    const result = authorize(db, 'patt_1')
    expect(result).toEqual({ ok: false, reasonCode: 'publish_in_progress' })
    expectRefused(db, 'publish_in_progress')
  })
})

describe('landReady mirrors the gate exactly', () => {
  function project(overrides: Partial<ProjectionSourceTask>): boolean {
    const source = {
      taskId: 't',
      repoId: 'r',
      title: 't',
      state: 'committed',
      activePhase: null,
      risk: 'low',
      source: 'custom',
      triageDecision: null,
      triageRunStatus: null,
      triageBlockedReasonCode: null,
      planRound: 0,
      fixRound: 0,
      lastVerdict: null,
      blockedReasonCode: null,
      approvalState: 'none',
      approvalExpiresAt: null,
      auditApprovedTreeOid: null,
      committedSha: SHA,
      commitAttemptStatus: 'completed',
      commitReasonCode: null,
      commitAdvisoryCode: null,
      publishAttemptStatus: 'completed',
      publishedSha: SHA,
      publishReasonCode: null,
      publishAdvisoryCode: null,
      reviewProvider: null,
      reviewNumber: null,
      commitAttemptPublishable: true,
      landAttemptStatus: null,
      landedSha: null,
      landingReasonCode: null,
      landingAdvisoryCode: null,
      publishAttemptLandable: true,
      landHostSupported: true,
      auditApprovedForCurrentCandidate: false,
      approvalPendingAndValid: false,
      reconcileClass: null,
      reconcileReasonCode: null,
      worktreeProvenance: null,
      worktreeVerifiedAt: null,
      worktreeReasonCode: null,
      executionRunStatus: null,
      executionReasonCode: null,
      executionOutputTruncated: false,
      planArtifactId: null,
      planArtifactStatus: null,
      planArtifactTruncated: false,
      planArtifactRedactionCount: 0,
      planReviewRunStatus: null,
      planReviewVerdict: null,
      planReviewReasonCode: null,
      planReviewSummary: null,
      planReviewFindingCount: null,
      planReviewApprovedForCurrentArtifact: false,
      coverageAvailable: false,
      candidateStatus: null,
      codeAuditRunStatus: null,
      codeAuditVerdict: null,
      codeAuditReasonCode: null,
      codeAuditSummary: null,
      codeAuditFindingCount: null,
      fixRoundLimit: 3,
      acceptanceCriteria: [],
      timings: [],
      createdAt: 1,
      updatedAt: 1,
      ...overrides
    } as ProjectionSourceTask
    return buildAuditedTaskProjection(source).landReady
  }

  it('is true only when BOTH bindings hold on a local committed task', () => {
    expect(project({})).toBe(true)
  })

  it('is FALSE when the publication binding does not resolve', () => {
    expect(project({ publishAttemptLandable: false })).toBe(false)
  })

  it('is FALSE when the Phase 8 binding does not resolve', () => {
    expect(project({ commitAttemptPublishable: false })).toBe(false)
  })

  it('is FALSE while a publish outcome is unknown', () => {
    expect(project({ publishAttemptStatus: 'authorized' })).toBe(false)
  })

  it('is FALSE while a land outcome is unknown, and Recheck is offered instead', () => {
    expect(project({ landAttemptStatus: 'authorized' })).toBe(false)
  })

  it('is FALSE on an unsupported host', () => {
    expect(project({ landHostSupported: false })).toBe(false)
  })

  it.each([['selected'], ['implementing'], ['committing'], ['landed'], ['blocked']])(
    'is FALSE in the non-committed state %s',
    (state) => {
      expect(project({ state } as Partial<ProjectionSourceTask>)).toBe(false)
    }
  )

  it('IGNORES the publish advisory — a deferred review still lands', () => {
    expect(project({ publishAdvisoryCode: 'review_request_deferred' })).toBe(true)
  })
})
