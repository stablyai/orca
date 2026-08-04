// Phase 9 §5.5 — the post-confirmation advisory contract.
//
// THE CENTRAL PROPERTY: once the push is confirmed, the attempt is permanently
// `completed` under EVERY review-request outcome, reason_code stays NULL, and
// the outcome is carried by publish_advisory — which can never hold a
// PublishReasonCode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PUBLISH_ADVISORY_CODES,
  PUBLISH_REASON_CODES,
  canRetryReviewRequest,
  type PublishAdvisoryCode
} from '../../shared/audited-publish-types'
import { createAuditedWorkflowTables } from './audited-task-schema'
import {
  completePublishAttempt,
  getLatestPublishAttempt,
  recordReviewOutcome
} from './audited-publish-attempt-repository'
import Database from '../sqlite/sync-database'

const SHA = 'c'.repeat(40)
const BASE = 'b'.repeat(40)

const forgeProvider = vi.hoisted(() => ({ current: null as unknown }))

vi.mock('../source-control/forge-provider', () => ({
  getForgeProviderForRepository: vi.fn(async () => forgeProvider.current)
}))

describe('the two vocabularies are disjoint', () => {
  it('no advisory code is also a reason code', () => {
    const reasons = new Set<string>(PUBLISH_REASON_CODES)
    for (const advisory of PUBLISH_ADVISORY_CODES) {
      expect(reasons.has(advisory)).toBe(false)
    }
  })

  it('offers the creation retry only for actionable or transient advisories', () => {
    expect(canRetryReviewRequest('review_request_auth_required')).toBe(true)
    expect(canRetryReviewRequest('review_request_validation_failed')).toBe(true)
    expect(canRetryReviewRequest('review_request_deferred')).toBe(true)
    expect(canRetryReviewRequest('review_request_ambiguous')).toBe(true)
    // Terminal or already-done: no retry action should render.
    expect(canRetryReviewRequest('review_request_unsupported_provider')).toBe(false)
    expect(canRetryReviewRequest('review_request_created')).toBe(false)
    expect(canRetryReviewRequest('review_request_already_exists')).toBe(false)
    expect(canRetryReviewRequest(null)).toBe(false)
  })
})

describe('a confirmed push stays completed under every review outcome', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    createAuditedWorkflowTables(db)
    db.prepare(
      `INSERT INTO audited_tasks
         (id, repo_id, source_repo_path, base_commit, host_id, title, spec_json, source,
          risk, state, branch_name, worktree_path, committed_sha, created_at_ms, updated_at_ms)
       VALUES ('task1', 'repo1', '/repo', ?, 'local', 't', '{}', 'custom', 'low', 'committed',
               'feature', '/wt', ?, 1, 1)`
    ).run(BASE, SHA)
    db.prepare(
      `INSERT INTO audited_publish_attempts
         (id, task_id, commit_attempt_id, intended_sha, intended_branch, intended_remote,
          status, push_started, authorized_at_ms)
       VALUES ('patt_1', 'task1', 'catt_1', ?, 'feature', 'origin', 'authorized', 1, 10)`
    ).run(SHA)
    completePublishAttempt(db, { attemptId: 'patt_1', taskId: 'task1', pushedSha: SHA }, 100)
  })

  afterEach(() => {
    db.close()
  })

  it.each(PUBLISH_ADVISORY_CODES)(
    'keeps status completed and reason_code NULL for %s',
    (advisory: PublishAdvisoryCode) => {
      recordReviewOutcome(db, {
        attemptId: 'patt_1',
        taskId: 'task1',
        advisory,
        provider: 'github',
        number: advisory === 'review_request_created' ? 7 : null,
        url: null,
        created: advisory === 'review_request_created'
      })

      const attempt = getLatestPublishAttempt(db, 'task1')
      expect(attempt?.status).toBe('completed')
      expect(attempt?.reasonCode).toBeNull()
      expect(attempt?.pushedSha).toBe(SHA)
      expect(attempt?.publishAdvisory).toBe(advisory)

      const task = db
        .prepare(`SELECT state, published_sha FROM audited_tasks WHERE id = 'task1'`)
        .get() as { state: string; published_sha: string }
      expect(task.state).toBe('committed')
      expect(task.published_sha).toBe(SHA)
    }
  )

  it('stores an advisory member, never a reason code', () => {
    recordReviewOutcome(db, {
      attemptId: 'patt_1',
      taskId: 'task1',
      advisory: 'review_request_auth_required',
      provider: 'gitlab',
      number: null,
      url: null,
      created: false
    })
    const stored = getLatestPublishAttempt(db, 'task1')!.publishAdvisory!
    expect(PUBLISH_ADVISORY_CODES).toContain(stored)
    expect(PUBLISH_REASON_CODES).not.toContain(stored as never)
  })
})

describe('requestReview maps provider outcomes to distinct advisories', () => {
  beforeEach(() => {
    vi.resetModules()
    forgeProvider.current = null
  })

  async function run(provider: unknown) {
    forgeProvider.current = provider
    const { requestReview } = await import('./audited-publish-review')
    return requestReview({
      repoPath: '/wt',
      branch: 'feature',
      baseBranch: 'main',
      title: 'A change',
      body: '',
      draft: false
    })
  }

  function stubProvider(overrides: Record<string, unknown>) {
    return {
      id: 'github',
      supportsReviewCreation: true,
      resolveRepository: async () => ({}),
      getReviewForBranch: async () => null,
      getReviewByNumber: async () => null,
      ...overrides
    }
  }

  it('reports unsupported for a provider that cannot create reviews', async () => {
    const outcome = await run(
      stubProvider({ id: 'bitbucket', supportsReviewCreation: false, createReview: undefined })
    )
    expect(outcome.advisory).toBe('review_request_unsupported_provider')
    expect(outcome.number).toBeNull()
  })

  it('adopts an existing open review instead of creating a duplicate', async () => {
    const createReview = vi.fn()
    const outcome = await run(
      stubProvider({
        getReviewForBranch: async () => ({ number: 12, url: 'https://example/12' }),
        createReview
      })
    )
    expect(outcome.advisory).toBe('review_request_already_exists')
    expect(outcome.number).toBe(12)
    expect(createReview).not.toHaveBeenCalled()
  })

  it('REFUSES to create when the existence lookup itself failed', async () => {
    const createReview = vi.fn()
    const outcome = await run(
      stubProvider({
        getReviewForBranch: async () => {
          throw new Error('upstream down')
        },
        createReview
      })
    )
    // Duplicate safety: we could not know, so we do not create.
    expect(outcome.advisory).toBe('review_request_deferred')
    expect(createReview).not.toHaveBeenCalled()
  })

  it('reports created on success', async () => {
    const outcome = await run(
      stubProvider({
        createReview: async () => ({ ok: true, number: 42, url: 'https://example/42' })
      })
    )
    expect(outcome.advisory).toBe('review_request_created')
    expect(outcome.number).toBe(42)
    expect(outcome.created).toBe(true)
  })

  it.each([
    ['auth_required', 'review_request_auth_required'],
    ['validation', 'review_request_validation_failed'],
    ['unknown_completion', 'review_request_ambiguous'],
    ['timeout', 'review_request_ambiguous'],
    ['unknown', 'review_request_deferred'],
    ['push_failed', 'review_request_deferred'],
    ['unsupported_provider', 'review_request_unsupported_provider']
  ])('maps the provider error %s to %s', async (code, expected) => {
    const outcome = await run(
      stubProvider({ createReview: async () => ({ ok: false, code, error: 'raw provider text' }) })
    )
    expect(outcome.advisory).toBe(expected)
  })

  it('never surfaces raw provider error text', async () => {
    const outcome = await run(
      stubProvider({
        createReview: async () => ({
          ok: false,
          code: 'validation',
          error: 'https://token@host rejected: secret detail'
        })
      })
    )
    expect(JSON.stringify(outcome)).not.toContain('secret detail')
    expect(JSON.stringify(outcome)).not.toContain('token@host')
  })

  it('defers rather than failing when the provider throws', async () => {
    const outcome = await run(
      stubProvider({
        createReview: async () => {
          throw new Error('boom')
        }
      })
    )
    expect(outcome.advisory).toBe('review_request_deferred')
  })

  it('defers when no provider can be detected', async () => {
    const outcome = await run(null)
    expect(outcome.advisory).toBe('review_request_deferred')
    expect(outcome.provider).toBeNull()
  })
})
