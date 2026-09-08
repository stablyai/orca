import { describe, expect, it } from 'vitest'
import {
  REVIEW_BRANCH,
  REVIEW_HEAD,
  REVIEW_IDENTITY,
  reviewRuntime,
  reviewStatus,
  runReviewMethod
} from './mobile-web-review-test-fixture'

const eligible = {
  provider: 'github',
  review: null,
  canCreate: true,
  blockedReason: null,
  nextAction: null,
  reviewLookupOutcome: 'not_found'
}

function creationRuntime(overrides: Record<string, unknown> = {}) {
  return reviewRuntime({
    getRuntimeGitStatus: reviewStatus(),
    getRuntimeGitUpstreamStatus: { hasUpstream: true, ahead: 2, behind: 0 },
    showManagedWorktree: { linkedPR: 7, linkedGitLabMR: null },
    getHostedReviewCreationEligibility: eligible,
    ...overrides
  })
}

describe('host-projected provider review creation', () => {
  it('reports the working tree, upstream distance and linked reviews to the host', async () => {
    const f = creationRuntime({
      getRuntimeGitStatus: reviewStatus({ entries: [{ path: 'src/app.ts' }] })
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.creationEligibility',
        { ...REVIEW_IDENTITY, base: 'main' },
        f.context
      )
    ).resolves.toMatchObject({
      observedHead: REVIEW_HEAD,
      branch: REVIEW_BRANCH,
      provider: 'github',
      canCreate: true,
      reviewLookupOutcome: 'not_found'
    })
    expect(f.calls.at(-1)?.args[0]).toMatchObject({
      repoSelector: 'id:repo-1',
      branch: REVIEW_BRANCH,
      base: 'main',
      hasUncommittedChanges: true,
      hasUpstream: true,
      ahead: 2,
      behind: 0,
      linkedGitHubPR: 7,
      linkedGitLabMR: null
    })
  })

  it('refuses eligibility composed against a branch the worktree has left', async () => {
    const f = creationRuntime({ getRuntimeGitStatus: reviewStatus({ branch: 'main' }) })

    await expect(
      runReviewMethod('mobileWeb.review.creationEligibility', REVIEW_IDENTITY, f.context)
    ).rejects.toThrow('conflict')
  })

  it('clips an oversized generated body to the page contract', async () => {
    const f = creationRuntime({
      getHostedReviewCreationEligibility: {
        ...eligible,
        title: 't'.repeat(2_000),
        body: 'b'.repeat(64 * 1024)
      }
    })

    const result = (await runReviewMethod(
      'mobileWeb.review.creationEligibility',
      REVIEW_IDENTITY,
      f.context
    )) as { title: string; body: string }

    expect(result.title).toHaveLength(512)
    expect(result.body).toHaveLength(32 * 1024)
  })

  it('creates a review only while the host still says it can be created', async () => {
    const f = creationRuntime({ createHostedReview: { ok: true, number: 42, url: 'x' } })

    await expect(
      runReviewMethod(
        'mobileWeb.review.create',
        {
          ...REVIEW_IDENTITY,
          provider: 'gitlab',
          base: 'main',
          title: 'Add the review lane',
          body: '',
          draft: false
        },
        f.context
      )
    ).rejects.toThrow('conflict')
    expect(f.calls.map((call) => call.method)).not.toContain('createHostedReview')
  })

  it('creates a review and reports the number and url the host answered', async () => {
    const f = creationRuntime({
      createHostedReview: {
        ok: true,
        number: 42,
        url: 'https://github.example/acme/orca/pull/42'
      }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.create',
        {
          ...REVIEW_IDENTITY,
          provider: 'github',
          base: 'main',
          title: 'Add the review lane',
          body: 'Body',
          draft: true
        },
        f.context
      )
    ).resolves.toEqual({
      provider: 'github',
      ok: true,
      number: 42,
      url: 'https://github.example/acme/orca/pull/42'
    })
    expect(f.calls.at(-1)?.args[0]).toMatchObject({
      repoSelector: 'id:repo-1',
      base: 'main',
      title: 'Add the review lane',
      draft: true
    })
  })

  it('reports a refused creation with the host code instead of failing the call', async () => {
    const f = creationRuntime({
      createHostedReview: {
        ok: false,
        code: 'already_exists',
        error: 'e'.repeat(4_000),
        existingReview: { number: 7, url: 'https://github.example/acme/orca/pull/7' }
      }
    })

    const result = (await runReviewMethod(
      'mobileWeb.review.create',
      {
        ...REVIEW_IDENTITY,
        provider: 'github',
        base: 'main',
        title: 'Add the review lane',
        body: '',
        draft: false
      },
      f.context
    )) as { error: string; existingReview: { number: number } }

    expect(result.error).toHaveLength(1024)
    expect(result.existingReview).toEqual({
      number: 7,
      url: 'https://github.example/acme/orca/pull/7'
    })
  })

  it('generates review fields for the addressed worktree', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      generateRuntimePullRequestFields: {
        success: true,
        fields: { base: 'main', title: 'Generated', body: 'Body', draft: false }
      }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.generateFields',
        { ...REVIEW_IDENTITY, base: 'main', title: '', body: '', draft: false },
        f.context
      )
    ).resolves.toEqual({
      success: true,
      fields: { base: 'main', title: 'Generated', body: 'Body', draft: false }
    })
    expect(f.calls.at(-1)).toEqual({
      method: 'generateRuntimePullRequestFields',
      args: ['id:repo-1::/private/workspace', { base: 'main', title: '', body: '', draft: false }]
    })
  })

  it('reports a failed field generation rather than failing the call', async () => {
    const f = reviewRuntime({
      getRuntimeGitStatus: reviewStatus(),
      generateRuntimePullRequestFields: { success: false, error: 'no model configured' }
    })

    await expect(
      runReviewMethod(
        'mobileWeb.review.generateFields',
        { ...REVIEW_IDENTITY, base: 'main', title: '', body: '', draft: false },
        f.context
      )
    ).resolves.toEqual({ success: false, error: 'no model configured' })
  })
})
