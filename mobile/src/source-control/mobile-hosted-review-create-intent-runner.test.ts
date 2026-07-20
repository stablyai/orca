import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import {
  isMobileHostedReviewCommitFailure,
  runMobileHostedReviewCreateIntent
} from './mobile-hosted-review-create-intent-runner'

function ok(result: unknown): RpcSuccess {
  return { id: 'r', ok: true, result, _meta: { runtimeId: 'rt' } }
}

function fail(message: string): RpcFailure {
  return { id: 'r', ok: false, error: { code: 'x', message }, _meta: { runtimeId: 'rt' } }
}

function status(entries: unknown[], upstreamStatus = { hasUpstream: true, ahead: 0, behind: 0 }) {
  return {
    entries,
    conflictOperation: 'unknown',
    branch: 'feature/x',
    head: 'sha',
    upstreamStatus
  }
}

function entry(area: 'unstaged' | 'staged') {
  return { path: 'a.ts', status: 'modified', area }
}

function eligibility(overrides: Record<string, unknown>) {
  return {
    provider: 'github',
    review: null,
    defaultBaseRef: 'main',
    title: 'Ship mobile PR create',
    body: 'Generated body',
    // Accepted no-review lookup so Create / Push & Create is allowed unless overridden.
    reviewLookupOutcome: 'not_found',
    ...overrides
  }
}

function clientWith(responses: RpcResponse[]): Pick<RpcClient, 'sendRequest'> & {
  calls: Array<{ method: string; params: unknown }>
} {
  const calls: Array<{ method: string; params: unknown }> = []
  return {
    calls,
    sendRequest: vi.fn(async (method: string, params?: unknown) => {
      calls.push({ method, params })
      return responses.shift() ?? fail(`unexpected ${method}`)
    })
  }
}

describe('runMobileHostedReviewCreateIntent', () => {
  it('prepares the branch and creates the hosted review in one flow', async () => {
    const client = clientWith([
      ok(status([entry('unstaged')])),
      ok({ success: true }),
      ok(status([entry('staged')])),
      ok({ success: true, message: 'Ship mobile PR create' }),
      ok({ success: true }),
      ok(status([], { hasUpstream: true, ahead: 1, behind: 0 })),
      ok(eligibility({ canCreate: false, blockedReason: 'needs_push', nextAction: 'push' })),
      ok({ success: true }),
      ok(status([], { hasUpstream: true, ahead: 0, behind: 0 })),
      ok(eligibility({ canCreate: true, blockedReason: null, nextAction: null })),
      ok({ ok: true, number: 42, url: 'https://github.com/o/r/pull/42' }),
      ok({ worktree: { linkedPR: 42 } })
    ])
    const progress: string[] = []

    const result = await runMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
      branch: 'feature/x',
      title: 'feature/x',
      status: null,
      onProgress: (step) => progress.push(step)
    })

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        committed: true,
        url: 'https://github.com/o/r/pull/42'
      })
    )
    expect(progress).toEqual([
      'staging',
      'generating_commit_message',
      'committing',
      'pushing',
      'creating_review'
    ])
    expect(client.calls.map((call) => call.method)).toEqual([
      'git.status',
      'git.bulkStage',
      'git.status',
      'git.generateCommitMessage',
      'git.commit',
      'git.status',
      'hostedReview.getCreationEligibility',
      'git.push',
      'git.status',
      'hostedReview.getCreationEligibility',
      'hostedReview.create',
      'worktree.set'
    ])
  })

  it('does not create when eligibility remains blocked', async () => {
    const client = clientWith([
      ok(status([])),
      ok(eligibility({ canCreate: false, blockedReason: 'auth_required', nextAction: 'auth' }))
    ])

    await expect(
      runMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Authenticate before creating a pull request.',
      committed: false,
      status: expect.objectContaining({ entries: [] })
    })
    expect(client.calls.map((call) => call.method)).toEqual([
      'git.status',
      'hostedReview.getCreationEligibility'
    ])
  })

  it('reports committed work when creation fails after the automatic commit', async () => {
    const client = clientWith([
      ok(status([entry('staged')])),
      ok({ success: true }),
      ok(status([])),
      ok(eligibility({ canCreate: true, blockedReason: null, nextAction: null })),
      ok({ ok: false, code: 'validation', error: 'Create PR failed: bad base' })
    ])

    await expect(
      runMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null,
        commitMessage: 'Use my message'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Create PR failed: bad base',
      committed: true,
      status: expect.objectContaining({ entries: [] })
    })
  })
})

describe('isMobileHostedReviewCommitFailure', () => {
  it('only treats failed commit attempts as commit failures', () => {
    expect(
      isMobileHostedReviewCommitFailure(
        {
          ok: false,
          error: 'lint-staged failed',
          committed: false,
          status: status([entry('staged')]),
          commitMessage: 'Generated commit'
        },
        'committing'
      )
    ).toBe(true)

    expect(
      isMobileHostedReviewCommitFailure(
        {
          ok: false,
          error: 'Authenticate before creating a pull request.',
          committed: true,
          status: status([])
        },
        'committing'
      )
    ).toBe(false)

    expect(
      isMobileHostedReviewCommitFailure(
        {
          ok: false,
          error: 'Failed to stage changes',
          committed: false,
          status: status([entry('unstaged')])
        },
        'staging'
      )
    ).toBe(false)
  })
})
