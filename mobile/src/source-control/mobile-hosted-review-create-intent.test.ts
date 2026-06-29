import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcFailure, RpcResponse, RpcSuccess } from '../transport/types'
import { prepareMobileHostedReviewCreateIntent } from './mobile-hosted-review-create-intent'

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

function entry(area: 'unstaged' | 'untracked' | 'staged') {
  return { path: 'a.ts', status: 'modified', area }
}

function unresolvedEntry(area: 'unstaged' | 'staged') {
  return { path: 'conflicted.ts', status: 'modified', area, conflictStatus: 'unresolved' }
}

function eligibility(overrides: Record<string, unknown>) {
  return {
    provider: 'github',
    review: null,
    defaultBaseRef: 'main',
    title: 'feature/x',
    body: '',
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

describe('prepareMobileHostedReviewCreateIntent', () => {
  it('stages, generates a commit, commits, pushes, then returns an eligible prefill', async () => {
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
      ok(eligibility({ canCreate: true, blockedReason: null, nextAction: null }))
    ])
    const progress: string[] = []

    const result = await prepareMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
      branch: 'feature/x',
      title: 'feature/x',
      status: null,
      onProgress: (step) => progress.push(step)
    })

    expect(result).toEqual({
      ok: true,
      committed: true,
      status: expect.objectContaining({
        entries: [],
        upstreamStatus: { hasUpstream: true, ahead: 0, behind: 0 }
      }),
      prefill: expect.objectContaining({ canCreate: true, blockedReason: null })
    })
    expect(progress).toEqual(['staging', 'generating_commit_message', 'committing', 'pushing'])
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
      'hostedReview.getCreationEligibility'
    ])
  })

  it('uses a provided commit message instead of generating one', async () => {
    const client = clientWith([
      ok(status([entry('staged')])),
      ok({ success: true }),
      ok(status([], { hasUpstream: true, ahead: 0, behind: 0 })),
      ok(eligibility({ canCreate: true, blockedReason: null, nextAction: null }))
    ])

    await expect(
      prepareMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null,
        commitMessage: 'Use my draft'
      })
    ).resolves.toEqual(expect.objectContaining({ ok: true, committed: true }))

    expect(client.calls.map((call) => call.method)).toEqual([
      'git.status',
      'git.commit',
      'git.status',
      'hostedReview.getCreationEligibility'
    ])
    expect(client.calls[1].params).toEqual({
      worktree: 'id:repo-1::/tmp/wt',
      message: 'Use my draft'
    })
  })

  it('blocks when refreshed status loses its branch during staging', async () => {
    const client = clientWith([
      ok(status([entry('unstaged')])),
      ok({ success: true }),
      ok({ ...status([entry('staged')]), branch: null })
    ])

    const result = await prepareMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
      branch: 'feature/x',
      title: 'feature/x',
      status: null
    })

    expect(result).toEqual({
      ok: false,
      error: 'Branch changed while preparing the pull request.',
      committed: false,
      status: expect.objectContaining({
        entries: [expect.objectContaining({ area: 'staged' })]
      })
    })
    expect(result.status?.branch).toBeUndefined()

    expect(client.calls.map((call) => call.method)).toEqual([
      'git.status',
      'git.bulkStage',
      'git.status'
    ])
  })

  it('preserves the status refresh error after staging instead of reporting a branch change', async () => {
    const client = clientWith([
      ok(status([entry('unstaged')])),
      ok({ success: true }),
      fail('Desktop disconnected while refreshing status')
    ])

    await expect(
      prepareMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Desktop disconnected while refreshing status',
      committed: false,
      status: expect.objectContaining({
        entries: [expect.objectContaining({ area: 'unstaged' })]
      })
    })

    expect(client.calls.map((call) => call.method)).toEqual([
      'git.status',
      'git.bulkStage',
      'git.status'
    ])
  })

  it('reports refresh failures after a successful commit without hiding that commit happened', async () => {
    const client = clientWith([
      ok(status([entry('staged')])),
      ok({ success: true }),
      fail('Unable to refresh after commit')
    ])

    await expect(
      prepareMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null,
        commitMessage: 'Use my message'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Unable to refresh after commit',
      committed: true,
      status: expect.objectContaining({
        entries: [expect.objectContaining({ area: 'staged' })]
      })
    })

    expect(client.calls.map((call) => call.method)).toEqual([
      'git.status',
      'git.commit',
      'git.status'
    ])
  })

  it('returns an actionable error when commit message generation fails', async () => {
    const client = clientWith([
      ok(status([entry('staged')])),
      ok({ success: false, error: 'no model configured' })
    ])

    await expect(
      prepareMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Could not generate a commit message. Add one in Source Control, then retry.',
      committed: false,
      status: expect.objectContaining({
        entries: [expect.objectContaining({ area: 'staged' })]
      })
    })

    expect(client.calls.map((call) => call.method)).toEqual([
      'git.status',
      'git.generateCommitMessage'
    ])
  })

  it('returns the attempted commit message and staged snapshot when commit fails', async () => {
    const client = clientWith([
      ok(status([entry('unstaged')])),
      ok({ success: true }),
      ok(status([entry('staged')])),
      ok({ success: true, message: 'Generated mobile commit' }),
      ok({ success: false, error: 'lint-staged failed' })
    ])

    await expect(
      prepareMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null
      })
    ).resolves.toEqual({
      ok: false,
      error: 'lint-staged failed',
      committed: false,
      commitMessage: 'Generated mobile commit',
      status: expect.objectContaining({
        entries: [expect.objectContaining({ area: 'staged' })]
      })
    })

    expect(client.calls.map((call) => call.method)).toEqual([
      'git.status',
      'git.bulkStage',
      'git.status',
      'git.generateCommitMessage',
      'git.commit'
    ])
  })

  it('blocks unresolved conflicts before attempting a commit', async () => {
    const client = clientWith([ok(status([entry('staged'), unresolvedEntry('unstaged')]))])

    await expect(
      prepareMobileHostedReviewCreateIntent(client, 'repo-1::/tmp/wt', {
        branch: 'feature/x',
        title: 'feature/x',
        status: null,
        commitMessage: 'Use my message'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'Resolve conflicts before creating a pull request.',
      committed: false,
      status: expect.objectContaining({
        entries: expect.arrayContaining([expect.objectContaining({ path: 'conflicted.ts' })])
      })
    })

    expect(client.calls.map((call) => call.method)).toEqual(['git.status'])
  })
})
