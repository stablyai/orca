import { describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import {
  buildWorktreeSetHostedReviewLinkParams,
  fetchWorktreeGitHubPRLink,
  linkMobilePr
} from './mobile-pr-link'

describe('buildWorktreeSetHostedReviewLinkParams', () => {
  it.each([
    ['github', 'linkedPR'],
    ['gitlab', 'linkedGitLabMR'],
    ['bitbucket', 'linkedBitbucketPR'],
    ['azure-devops', 'linkedAzureDevOpsPR'],
    ['gitea', 'linkedGiteaPR']
  ] as const)('maps %s reviews to the matching worktree field', (provider, key) => {
    expect(buildWorktreeSetHostedReviewLinkParams('repo42::/p', provider, 12)).toEqual({
      worktree: 'id:repo42::/p',
      [key]: 12
    })
  })

  it('includes a submitted base ref so mobile diff review refreshes against the review base', () => {
    expect(
      buildWorktreeSetHostedReviewLinkParams('repo42::/p', 'github', 12, {
        baseRef: ' origin/release '
      })
    ).toEqual({
      worktree: 'id:repo42::/p',
      baseRef: 'origin/release',
      linkedPR: 12
    })
  })

  it('does not invent a metadata field for unsupported providers', () => {
    expect(buildWorktreeSetHostedReviewLinkParams('repo42::/p', 'unsupported', 12)).toEqual({
      worktree: 'id:repo42::/p'
    })
  })
})

describe('fetchWorktreeGitHubPRLink', () => {
  const client = (result: unknown, okFlag = true) =>
    ({
      sendRequest: vi.fn(async () =>
        okFlag ? { ok: true, result } : { ok: false, error: { message: 'x' } }
      )
    }) as unknown as Pick<RpcClient, 'sendRequest'>
  const none = { linkedPR: null, suppressedGitHubPR: null, pushTarget: null }

  it('returns the linked and suppressed PR numbers when present', async () => {
    expect(
      await fetchWorktreeGitHubPRLink(
        client({ worktree: { linkedPR: null, suppressedGitHubPR: 12 } }),
        'w'
      )
    ).toMatchObject({ linkedPR: null, suppressedGitHubPR: 12, pushTarget: null })
  })

  it('returns nulls when unset, null, or non-numeric', async () => {
    expect(await fetchWorktreeGitHubPRLink(client({ worktree: {} }), 'w')).toMatchObject(none)
    expect(
      await fetchWorktreeGitHubPRLink(client({ worktree: { linkedPR: 'x' } }), 'w')
    ).toMatchObject(none)
  })

  it('returns nulls when the request fails or rejects', async () => {
    expect(await fetchWorktreeGitHubPRLink(client(null, false), 'w')).toEqual(none)
    const rejecting = {
      sendRequest: vi.fn(async () => {
        throw new Error('transport closed')
      })
    } as unknown as Pick<RpcClient, 'sendRequest'>
    expect(await fetchWorktreeGitHubPRLink(rejecting, 'w')).toEqual(none)
  })
})

describe('linkMobilePr transport rejection', () => {
  it('normalizes a thrown sendRequest into { ok:false, error }', async () => {
    const rejecting = {
      sendRequest: vi.fn(async () => {
        throw new Error('socket hung up')
      })
    } as unknown as Pick<RpcClient, 'sendRequest'>
    expect(await linkMobilePr(rejecting, 'w', 5)).toEqual({ ok: false, error: 'socket hung up' })
  })
})
