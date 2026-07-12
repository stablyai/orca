import { describe, expect, it, vi } from 'vitest'
import type { RpcResponse } from '../transport/types'
import { mobileRepoSelectorFromWorktreeId } from '../source-control/mobile-pr-create'
import {
  buildGithubPrParams,
  fetchAssignableUsers,
  fetchGithubRepoSlug,
  fetchHostedReviewForBranch,
  fetchPRCheckDetails,
  fetchPRChecks,
  fetchPRForBranch,
  readAssignableUsers,
  readForBranch,
  readPRCheckDetails,
  readPRChecks,
  readPRForBranch,
  readWorkItemDetails
} from './github-pr-rpc'

function okResponse(result: unknown): RpcResponse {
  return { id: 'x', ok: true, result, _meta: { runtimeId: 'r' } }
}

function errResponse(message: string): RpcResponse {
  return { id: 'x', ok: false, error: { code: 'failed', message }, _meta: { runtimeId: 'r' } }
}

function mockClient(response: RpcResponse) {
  const sendRequest = vi.fn(async (_method: string, _params?: unknown) => response)
  return { client: { sendRequest }, sendRequest }
}

const WORKTREE_ID = 'repo-42::/path/to/wt'

describe('readForBranch', () => {
  it('parses a valid HostedReviewInfo into provider + PR number', () => {
    const parsed = readForBranch({
      provider: 'github',
      number: 7,
      title: 'My PR',
      state: 'open',
      url: 'https://example/7',
      status: 'success',
      updatedAt: '2026-01-01',
      mergeable: 'MERGEABLE'
    })
    expect(parsed?.provider).toBe('github')
    expect(parsed?.number).toBe(7)
    expect(parsed?.state).toBe('open')
  })

  it('returns null for null/non-record input', () => {
    expect(readForBranch(null)).toBeNull()
    expect(readForBranch('nope')).toBeNull()
  })

  it('returns null when provider or number is unparseable', () => {
    expect(readForBranch({ number: 7 })).toBeNull()
    expect(readForBranch({ provider: 'github' })).toBeNull()
  })

  it('preserves a non-github provider (gate decides, not the parser)', () => {
    const parsed = readForBranch({ provider: 'gitlab', number: 3 })
    expect(parsed?.provider).toBe('gitlab')
    expect(parsed?.number).toBe(3)
  })
})

describe('readPRForBranch', () => {
  it('parses a valid PR record', () => {
    const parsed = readPRForBranch({
      number: 12,
      title: 'Feature',
      state: 'open',
      url: 'u',
      checksStatus: 'success',
      updatedAt: 'now',
      mergeable: 'MERGEABLE'
    })
    expect(parsed?.number).toBe(12)
    expect(parsed?.state).toBe('open')
    expect(parsed?.checksStatus).toBe('success')
  })

  it('returns null for null result', () => {
    expect(readPRForBranch(null)).toBeNull()
  })

  it('narrows without throwing on missing/extra fields, dropping unknowns', () => {
    const parsed = readPRForBranch({ number: 5, state: 'closed', bogus: { deep: 1 } })
    expect(parsed?.number).toBe(5)
    expect(parsed?.state).toBe('closed')
    expect(parsed?.title).toBe('')
    expect('bogus' in (parsed ?? {})).toBe(false)
  })

  it('returns null when number/state is missing', () => {
    expect(readPRForBranch({ state: 'open' })).toBeNull()
    expect(readPRForBranch({ number: 1 })).toBeNull()
  })

  it('parses prRepo and mergeMethodSettings when present', () => {
    const parsed = readPRForBranch({
      number: 3,
      state: 'open',
      prRepo: { owner: 'forkOwner', repo: 'forkRepo' },
      mergeMethodSettings: {
        defaultMethod: 'squash',
        allowedMethods: { merge: false, squash: true, rebase: true }
      }
    })
    expect(parsed?.prRepo).toEqual({ owner: 'forkOwner', repo: 'forkRepo' })
    expect(parsed?.mergeMethodSettings).toEqual({
      defaultMethod: 'squash',
      allowedMethods: { merge: false, squash: true, rebase: true }
    })
  })

  it('drops a malformed prRepo / mergeMethodSettings without throwing', () => {
    const parsed = readPRForBranch({
      number: 3,
      state: 'open',
      prRepo: { owner: 'onlyOwner' },
      mergeMethodSettings: { allowedMethods: {} }
    })
    expect(parsed?.prRepo).toBeUndefined()
    expect(parsed?.mergeMethodSettings).toBeUndefined()
  })
})

describe('readWorkItemDetails', () => {
  it('parses state/title/author/base+head/reviewRequests/latestReviews', () => {
    const parsed = readWorkItemDetails({
      item: {
        id: 'n1',
        type: 'pr',
        number: 9,
        title: 'T',
        state: 'open',
        url: 'u',
        author: 'octo',
        baseRefName: 'main',
        branchName: 'feat',
        reviewRequests: [{ login: 'rev1', name: 'Rev One', avatarUrl: 'a' }],
        latestReviews: [{ login: 'rev2', state: 'APPROVED' }]
      },
      body: 'body',
      headSha: 'abc',
      baseSha: 'def'
    })
    expect(parsed?.item.author).toBe('octo')
    expect(parsed?.item.baseRefName).toBe('main')
    expect(parsed?.item.reviewRequests).toEqual([
      { login: 'rev1', name: 'Rev One', avatarUrl: 'a' }
    ])
    expect(parsed?.item.latestReviews).toEqual([
      { login: 'rev2', state: 'APPROVED', avatarUrl: null }
    ])
    expect(parsed?.headSha).toBe('abc')
  })

  it('skips malformed latestReviews entries without being fatal', () => {
    const parsed = readWorkItemDetails({
      item: {
        id: 'n',
        type: 'pr',
        number: 1,
        state: 'open',
        latestReviews: [{ login: 'ok' }, 42, {}]
      }
    })
    expect(parsed?.item.latestReviews).toEqual([{ login: 'ok', state: null, avatarUrl: null }])
  })

  it('accepts raw gh latestReviews author.login nesting', () => {
    const parsed = readWorkItemDetails({
      item: {
        id: 'n',
        type: 'pr',
        number: 1,
        state: 'open',
        latestReviews: [
          { author: { login: 'coderabbitai', avatarUrl: 'https://a' }, state: 'COMMENTED' }
        ]
      }
    })
    expect(parsed?.item.latestReviews).toEqual([
      { login: 'coderabbitai', state: 'COMMENTED', avatarUrl: 'https://a' }
    ])
  })

  it('returns null when item is unparseable', () => {
    expect(readWorkItemDetails({ item: { number: 1 } })).toBeNull()
    expect(readWorkItemDetails(null)).toBeNull()
  })
})

describe('readPRChecks', () => {
  it('parses an array of mixed pending/completed checks', () => {
    const parsed = readPRChecks([
      { name: 'build', status: 'completed', conclusion: 'success', url: 'u1' },
      { name: 'test', status: 'in_progress', conclusion: null, url: null }
    ])
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ name: 'build', status: 'completed', conclusion: 'success' })
    expect(parsed[1]).toMatchObject({ name: 'test', status: 'in_progress', conclusion: null })
  })

  it('returns [] for non-array input', () => {
    expect(readPRChecks(null)).toEqual([])
    expect(readPRChecks({})).toEqual([])
  })

  it('skips bad entries instead of throwing', () => {
    const parsed = readPRChecks([
      { name: 'ok', status: 'queued', conclusion: null, url: null },
      7,
      {}
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.name).toBe('ok')
  })

  it('coerces an unknown conclusion to null (pending check renders as pending, not failure)', () => {
    const parsed = readPRChecks([
      { name: 'c', status: 'in_progress', conclusion: 'weird', url: null }
    ])
    expect(parsed[0]?.conclusion).toBeNull()
  })
})

describe('readPRCheckDetails', () => {
  it('parses valid details including annotations and jobs', () => {
    const parsed = readPRCheckDetails({
      name: 'CI',
      status: 'completed',
      conclusion: 'failure',
      annotations: [{ message: 'boom', path: 'a.ts', startLine: 1, endLine: 2 }, 'bad'],
      jobs: [{ name: 'job1', steps: [{ name: 'step1' }, 99] }]
    })
    expect(parsed?.name).toBe('CI')
    expect(parsed?.annotations).toHaveLength(1)
    expect(parsed?.jobs[0]?.steps).toHaveLength(1)
  })

  it('returns null for null/garbage', () => {
    expect(readPRCheckDetails(null)).toBeNull()
    expect(readPRCheckDetails({ status: 'x' })).toBeNull()
  })
})

describe('readAssignableUsers', () => {
  it('parses users and skips entries without a login', () => {
    const parsed = readAssignableUsers([
      { login: 'a', name: 'A', avatarUrl: 'av' },
      { name: 'no login' },
      'bad'
    ])
    expect(parsed).toEqual([{ login: 'a', name: 'A', avatarUrl: 'av' }])
  })

  it('returns [] for non-array (empty list edge)', () => {
    expect(readAssignableUsers(undefined)).toEqual([])
    expect(readAssignableUsers([])).toEqual([])
  })
})

describe('buildGithubPrParams — method-aware prRepo / headSha', () => {
  const fork = { owner: 'forkOwner', repo: 'forkRepo' }

  it('reuses mobileRepoSelectorFromWorktreeId for the repo selector', () => {
    const params = buildGithubPrParams('github.prChecks', WORKTREE_ID, { prNumber: 1 })
    expect(params.repo).toBe(mobileRepoSelectorFromWorktreeId(WORKTREE_ID))
    expect(params.repo).toBe('id:repo-42')
  })

  it('attaches prRepo for methods that accept it', () => {
    for (const method of [
      'github.prChecks',
      'github.prCheckDetails',
      'github.mergePR',
      'github.setPRAutoMerge',
      'github.prComments'
    ]) {
      const params = buildGithubPrParams(method, WORKTREE_ID, { prNumber: 1 }, { prRepo: fork })
      expect(params.prRepo).toEqual(fork)
    }
  })

  it('omits prRepo for methods that reject it', () => {
    for (const method of [
      'github.updatePRState',
      'github.requestPRReviewers',
      'github.removePRReviewers',
      'github.listAssignableUsers',
      'github.rerunPRChecks'
    ]) {
      const params = buildGithubPrParams(method, WORKTREE_ID, { prNumber: 1 }, { prRepo: fork })
      expect('prRepo' in params).toBe(false)
    }
  })

  it('forwards headSha only to github.prChecks', () => {
    const checks = buildGithubPrParams(
      'github.prChecks',
      WORKTREE_ID,
      { prNumber: 1 },
      {
        headSha: 'sha123'
      }
    )
    expect(checks.headSha).toBe('sha123')

    const details = buildGithubPrParams(
      'github.prCheckDetails',
      WORKTREE_ID,
      {},
      {
        headSha: 'sha123'
      }
    )
    expect('headSha' in details).toBe(false)
  })

  it('does not attach prRepo/headSha when not supplied', () => {
    const params = buildGithubPrParams('github.prChecks', WORKTREE_ID, { prNumber: 1 })
    expect('prRepo' in params).toBe(false)
    expect('headSha' in params).toBe(false)
  })
})

describe('fetch wrappers', () => {
  it('fetchHostedReviewForBranch sends linkedGitHubPR + reuses repo selector', async () => {
    const { client, sendRequest } = mockClient(okResponse({ provider: 'github', number: 4 }))
    const out = await fetchHostedReviewForBranch(client, WORKTREE_ID, {
      branch: 'feat',
      linkedGitHubPR: 4
    })
    expect(out.ok).toBe(true)
    expect(out.ok && out.result).toMatchObject({ provider: 'github', number: 4 })
    const [method, params] = sendRequest.mock.calls[0]!
    expect(method).toBe('hostedReview.forBranch')
    expect(params).toMatchObject({ repo: 'id:repo-42', branch: 'feat', linkedGitHubPR: 4 })
  })

  it('fetchPRForBranch threads linkedPRNumber as authoritative resolver', async () => {
    const { client, sendRequest } = mockClient(okResponse({ number: 4, state: 'open' }))
    const out = await fetchPRForBranch(client, WORKTREE_ID, { branch: 'feat', linkedPRNumber: 4 })
    expect(out.ok).toBe(true)
    const [method, params] = sendRequest.mock.calls[0]!
    expect(method).toBe('github.prForBranch')
    expect(params).toMatchObject({ branch: 'feat', linkedPRNumber: 4 })
    expect('prRepo' in (params as object)).toBe(false)
  })

  it('fetchPRChecks forwards headSha + prRepo', async () => {
    const { client, sendRequest } = mockClient(okResponse([]))
    await fetchPRChecks(client, WORKTREE_ID, {
      prNumber: 9,
      headSha: 'sha1',
      prRepo: { owner: 'o', repo: 'r' }
    })
    const [method, params] = sendRequest.mock.calls[0]!
    expect(method).toBe('github.prChecks')
    expect(params).toMatchObject({
      prNumber: 9,
      headSha: 'sha1',
      prRepo: { owner: 'o', repo: 'r' }
    })
  })

  it('fetchPRCheckDetails attaches prRepo but never headSha', async () => {
    const { client, sendRequest } = mockClient(okResponse({ name: 'CI' }))
    await fetchPRCheckDetails(client, WORKTREE_ID, {
      checkRunId: 3,
      prRepo: { owner: 'o', repo: 'r' }
    })
    const [, params] = sendRequest.mock.calls[0]!
    expect(params).toMatchObject({ checkRunId: 3, prRepo: { owner: 'o', repo: 'r' } })
    expect('headSha' in (params as object)).toBe(false)
  })

  it('fetchGithubRepoSlug returns the slug for a github repo, null otherwise', async () => {
    const found = await fetchGithubRepoSlug(
      mockClient(okResponse({ owner: 'o', repo: 'r' })).client,
      WORKTREE_ID
    )
    expect(found).toEqual({ ok: true, result: { owner: 'o', repo: 'r' } })
    const none = await fetchGithubRepoSlug(mockClient(okResponse(null)).client, WORKTREE_ID)
    expect(none).toEqual({ ok: true, result: null })
  })

  it('fetchAssignableUsers returns empty list edge without prRepo', async () => {
    const { client, sendRequest } = mockClient(okResponse([]))
    const out = await fetchAssignableUsers(client, WORKTREE_ID)
    expect(out).toEqual({ ok: true, result: [] })
    const [method, params] = sendRequest.mock.calls[0]!
    expect(method).toBe('github.listAssignableUsers')
    expect('prRepo' in (params as object)).toBe(false)
  })

  it('surfaces { ok:false, error } on a failed response', async () => {
    const { client } = mockClient(errResponse('permission denied'))
    const out = await fetchPRChecks(client, WORKTREE_ID, { prNumber: 1 })
    expect(out).toEqual({ ok: false, error: 'permission denied' })
  })

  it('normalizes a thrown sendRequest into { ok:false, error } (no escaping rejection)', async () => {
    const client = {
      sendRequest: vi.fn(async () => {
        throw new Error('transport closed')
      })
    }
    const out = await fetchPRChecks(client, WORKTREE_ID, { prNumber: 1 })
    expect(out).toEqual({ ok: false, error: 'transport closed' })
  })
})
