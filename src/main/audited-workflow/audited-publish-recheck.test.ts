// Phase 9 §6.1 — the user-triggered, READ-ONLY recovery path, and the shared
// classifier it uses.
//
// The properties proven here are what make an unknown outcome safe:
//   - classification is a PURE function shared by both recovery routes
//   - an unreadable remote leaves the attempt `authorized` and writes NOTHING
//   - a retry push is impossible until a classification frees the live-attempt
//     index, which only proven no_effect / ambiguous / published do
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAuditedWorkflowTables } from './audited-task-schema'
import {
  authorizePublishAttempt,
  failPublishAttempt,
  getLatestPublishAttempt,
  markPushStarted
} from './audited-publish-attempt-repository'
import { classifyPublishEvidence } from './audited-publish-classification'
import type { PublishAttemptRow } from './audited-publish-attempt-repository'
import Database from '../sqlite/sync-database'

const SHA = 'c'.repeat(40)
const LEASE = 'e'.repeat(40)
const THIRD = 'f'.repeat(40)
const BASE = 'b'.repeat(40)

function attempt(overrides: Partial<PublishAttemptRow> = {}): PublishAttemptRow {
  return {
    id: 'patt_1',
    taskId: 'task1',
    commitAttemptId: 'catt_1',
    intendedSha: SHA,
    intendedBranch: 'feature',
    intendedRemote: 'origin',
    expectedRemoteSha: LEASE,
    status: 'authorized',
    reasonCode: null,
    pushStarted: true,
    pushCompleted: false,
    pushedSha: null,
    reviewProvider: null,
    reviewNumber: null,
    reviewUrl: null,
    reviewCreated: false,
    publishAdvisory: null,
    authorizedAt: 1,
    finalizedAt: null,
    ...overrides
  }
}

describe('classifyPublishEvidence — the shared classifier', () => {
  it('reports no_effect when the push never started, even if the remote is unreadable', () => {
    const verdict = classifyPublishEvidence(attempt({ pushStarted: false }), {
      remote: { ok: false, reasonCode: 'remote_ref_unreadable' }
    })
    expect(verdict).toEqual({ kind: 'no_effect' })
  })

  it('reports unknown_remote when the push started and we cannot look', () => {
    const verdict = classifyPublishEvidence(attempt(), {
      remote: { ok: false, reasonCode: 'remote_ref_unreadable' }
    })
    expect(verdict).toEqual({ kind: 'unknown_remote' })
  })

  it('reports published when the remote carries the intended sha', () => {
    const verdict = classifyPublishEvidence(attempt(), { remote: { ok: true, sha: SHA } })
    expect(verdict).toEqual({ kind: 'published', pushedSha: SHA })
  })

  it('reports no_effect when the remote is still at the lease value', () => {
    const verdict = classifyPublishEvidence(attempt(), { remote: { ok: true, sha: LEASE } })
    expect(verdict).toEqual({ kind: 'no_effect' })
  })

  it('reports no_effect when the ref was expected absent and still is', () => {
    const verdict = classifyPublishEvidence(attempt({ expectedRemoteSha: null }), {
      remote: { ok: true, sha: null }
    })
    expect(verdict).toEqual({ kind: 'no_effect' })
  })

  it('reports ambiguous when the remote is at a third value', () => {
    const verdict = classifyPublishEvidence(attempt(), { remote: { ok: true, sha: THIRD } })
    expect(verdict).toEqual({ kind: 'ambiguous' })
  })

  it('reports ambiguous when a ref we expected to exist vanished', () => {
    const verdict = classifyPublishEvidence(attempt(), { remote: { ok: true, sha: null } })
    expect(verdict).toEqual({ kind: 'ambiguous' })
  })
})

describe('publish recovery is read-only and gates retries', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    db.prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source,
          risk, state, branch_name, worktree_path, worktree_verified_at_ms, committed_sha,
          created_at_ms, updated_at_ms)
       VALUES ('task1', 'repo1', '/repo', ?, 'local', 't', '{}', 'custom', 'low', 'committed',
               'feature', '/wt', 500, ?, 1, 1)`
    ).run(BASE, SHA)
    db.prepare(
      `INSERT INTO audited_commit_attempts
         (id, task_id, approval_id, intended_tree_oid, intended_parent, intended_branch,
          intended_message_sha, status, created_commit_sha, authorized_at_ms)
       VALUES ('catt_1', 'task1', 'appr_1', ?, ?, 'feature', 'msg', 'completed', ?, 10)`
    ).run('a'.repeat(40), BASE, SHA)
  })

  afterEach(() => {
    db.close()
  })

  function authorize() {
    return authorizePublishAttempt(
      db,
      {
        taskId: 'task1',
        commitAttemptId: 'catt_1',
        intendedSha: SHA,
        intendedBranch: 'feature',
        intendedRemote: 'origin',
        expectedWorktreePath: '/wt',
        expectedWorktreeVerifiedAt: 500
      },
      1000
    )
  }

  it('BLOCKS a second publish while an outcome is unknown', () => {
    expect(authorize().ok).toBe(true)
    markPushStarted(db, getLatestPublishAttempt(db, 'task1')!.id)
    // The attempt is still `authorized` — an unknown outcome. Admission refuses.
    expect(authorize()).toEqual({ ok: false, reasonCode: 'lock_contended' })
  })

  it('ALLOWS a retry only once a no_effect classification is recorded', () => {
    const first = authorize()
    expect(first.ok).toBe(true)
    const attemptId = getLatestPublishAttempt(db, 'task1')!.id
    markPushStarted(db, attemptId)
    expect(authorize().ok).toBe(false)

    // Recovery proves the push did not land.
    expect(
      failPublishAttempt(
        db,
        {
          attemptId,
          taskId: 'task1',
          status: 'failed_no_effect',
          reasonCode: 'interrupted',
          block: false
        },
        2000
      )
    ).toBe(true)

    // Only now is a fresh publish admissible.
    expect(authorize().ok).toBe(true)
  })

  it('keeps the task in committed on a no_effect classification', () => {
    authorize()
    const attemptId = getLatestPublishAttempt(db, 'task1')!.id
    failPublishAttempt(
      db,
      {
        attemptId,
        taskId: 'task1',
        status: 'failed_no_effect',
        reasonCode: 'interrupted',
        block: false
      },
      2000
    )
    const row = db
      .prepare(`SELECT state, committed_sha FROM audited_tasks WHERE id = 'task1'`)
      .get() as { state: string; committed_sha: string }
    expect(row.state).toBe('committed')
    // The local commit is untouched by a failed publish.
    expect(row.committed_sha).toBe(SHA)
  })

  it('blocks the task on ambiguous evidence WITHOUT disturbing committed_sha', () => {
    authorize()
    const attemptId = getLatestPublishAttempt(db, 'task1')!.id
    failPublishAttempt(
      db,
      {
        attemptId,
        taskId: 'task1',
        status: 'failed_ambiguous',
        reasonCode: 'push_evidence_ambiguous',
        block: true
      },
      2000
    )
    const row = db
      .prepare(
        `SELECT state, committed_sha, blocked_reason_code, pre_block_state
           FROM audited_tasks WHERE id = 'task1'`
      )
      .get() as {
      state: string
      committed_sha: string
      blocked_reason_code: string
      pre_block_state: string
    }
    expect(row.state).toBe('blocked')
    expect(row.blocked_reason_code).toBe('publish_process_failed')
    expect(row.pre_block_state).toBe('committed')
    expect(row.committed_sha).toBe(SHA)
  })

  it('a lost classification race is an inert no-op', () => {
    authorize()
    const attemptId = getLatestPublishAttempt(db, 'task1')!.id
    expect(
      failPublishAttempt(
        db,
        {
          attemptId,
          taskId: 'task1',
          status: 'failed_no_effect',
          reasonCode: 'interrupted',
          block: false
        },
        2000
      )
    ).toBe(true)
    // A second writer (e.g. the startup sweep racing the user's Recheck) loses.
    expect(
      failPublishAttempt(
        db,
        {
          attemptId,
          taskId: 'task1',
          status: 'failed_ambiguous',
          reasonCode: 'push_evidence_ambiguous',
          block: true
        },
        2100
      )
    ).toBe(false)
    expect(getLatestPublishAttempt(db, 'task1')?.status).toBe('failed_no_effect')
  })
})

describe('the recovery paths construct only ls-remote', () => {
  // A structural guard: neither recovery module may reach the push builder, so
  // "recovery classifies, it does not act" holds by construction rather than by
  // reviewer vigilance.
  it.each([
    ['startup sweep', './audited-publish-run-recovery.ts'],
    ['user-triggered recheck', './audited-publish-recovery-commands.ts']
  ])('the %s module imports no push builder', async (_label, file) => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL(file, import.meta.url), 'utf8')
    // Inspect the IMPORTS, not the prose: a comment explaining the rule must not
    // be mistaken for a violation of it.
    const imports = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    for (const forbidden of ['buildLeasedPushArgv', 'runLeasedPush', 'runAuditedGitPublish']) {
      expect(imports).not.toContain(forbidden)
    }
  })
})
