import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RawAzureDevOpsPullRequest } from './pull-request-mappers'

const { requestJson, readHead, headIsEquivalent } = vi.hoisted(() => ({
  requestJson: vi.fn(),
  readHead: vi.fn(),
  headIsEquivalent: vi.fn()
}))

vi.mock('./azure-devops-api-request', () => ({
  azureDevOpsTokenConfigured: () => true,
  getAzureDevOpsAuthConfig: () => ({}),
  normalizeAzureDevOpsApiBaseUrl: (value: string) => value,
  requestAzureDevOpsJson: requestJson,
  requestAzureDevOpsJsonAtBase: vi.fn()
}))
vi.mock('./repository-ref', () => ({
  getAzureDevOpsRepoRef: async () => ({
    host: 'dev.azure.com',
    project: 'proj',
    repository: 'repo',
    apiBaseUrl: 'https://dev.azure.com/org/proj',
    webBaseUrl: 'https://dev.azure.com/org/proj/_git/repo'
  })
}))
vi.mock('../source-control/repo-default-branch', () => ({
  shouldHideNonOpenReviewOnDefaultBranch: async () => false
}))
vi.mock('../source-control/review-current-head', () => ({ readCurrentReviewHead: readHead }))
vi.mock('../source-control/merged-review-head-equivalence', () => ({
  mergedReviewHeadIsEquivalent: headIsEquivalent
}))

import { getAzureDevOpsPullRequestForBranch } from './client'

function pr(id: number, status: string, head: string): RawAzureDevOpsPullRequest {
  return {
    pullRequestId: id,
    title: `PR ${id}`,
    status,
    creationDate: new Date(Date.UTC(2026, 0, id)).toISOString(),
    lastMergeSourceCommit: { commitId: head }
  }
}

function serve(
  pages: Record<string, RawAzureDevOpsPullRequest[]>,
  commits: string[] = []
): string[] {
  const listStatuses: string[] = []
  requestJson.mockImplementation(async (_repo, path: string, options) => {
    if (path.endsWith('/pullRequests')) {
      const status = options.searchParams['searchCriteria.status']
      listStatuses.push(status)
      return { value: pages[status] ?? [] }
    }
    if (path.endsWith('/commits')) {
      return { value: commits.map((commitId) => ({ commitId })) }
    }
    return path.endsWith('/statuses') ? [] : { id: 'repo-id' }
  })
  return listStatuses
}

describe('getAzureDevOpsPullRequestForBranch', () => {
  beforeEach(() => {
    requestJson.mockReset()
    readHead.mockReset()
    headIsEquivalent.mockReset()
    headIsEquivalent.mockResolvedValue(false)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('treats a completed PR as the branch review only while its head is the checkout HEAD', async () => {
    serve({ all: [pr(1, 'completed', 'old-head')] })
    await expect(
      getAzureDevOpsPullRequestForBranch('/repo', 'feature/x', null, null, {
        currentHeadOid: 'new-head'
      })
    ).resolves.toBeNull()

    readHead.mockResolvedValue('old-head')
    await expect(getAzureDevOpsPullRequestForBranch('/repo', 'feature/x')).resolves.toMatchObject({
      number: 1,
      state: 'merged'
    })
  })

  it('keeps a completed PR when HEAD is an earlier commit of it or the PR is linked', async () => {
    serve({ all: [pr(3, 'completed', 'final-head')] }, ['earlier-head', 'final-head'])
    const lookup = (currentHeadOid: string, linked: number | null = null) =>
      getAzureDevOpsPullRequestForBranch('/repo', 'feature/x', linked, null, { currentHeadOid })
    await expect(lookup('earlier-head')).resolves.toMatchObject({ number: 3, state: 'merged' })
    await expect(lookup('unrelated-head')).resolves.toBeNull()
    await expect(lookup('unrelated-head', 3)).resolves.toMatchObject({ number: 3 })
  })

  it('keeps a completed PR when HEAD is an equivalent local rebase of it', async () => {
    serve({ all: [{ ...pr(6, 'completed', 'final-head'), targetRefName: 'refs/heads/main' }] }, [
      'final-head'
    ])
    const lookup = (userRefresh = false) =>
      getAzureDevOpsPullRequestForBranch('/repo', 'feature/x', null, null, {
        currentHeadOid: 'rebased-head',
        userRefresh
      })
    await expect(lookup()).resolves.toBeNull()
    headIsEquivalent.mockResolvedValue(true)
    await expect(lookup(true)).resolves.toMatchObject({ number: 6, state: 'merged' })
    expect(headIsEquivalent).toHaveBeenLastCalledWith(
      expect.objectContaining({
        repoPath: '/repo',
        reviewHeadOid: 'final-head',
        baseBranchName: 'main',
        headOid: 'rebased-head'
      })
    )
  })

  it('reuses the rebase proof until the PR head, HEAD or target changes, the TTL ends or the user refreshes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const completed = (head: string, target: string) => ({
      ...pr(7, 'completed', head),
      targetRefName: `refs/heads/${target}`
    })
    const pages = { all: [completed('memo-head', 'main')] }
    serve(pages, ['memo-head'])
    headIsEquivalent.mockResolvedValue(true)
    const lookup = (currentHeadOid: string, userRefresh = false) =>
      getAzureDevOpsPullRequestForBranch('/repo', 'feature/x', null, null, {
        currentHeadOid,
        userRefresh
      })
    await expect(lookup('rebased-a')).resolves.toMatchObject({ number: 7, state: 'merged' })
    await expect(lookup('rebased-a')).resolves.toMatchObject({ number: 7, state: 'merged' })
    expect(headIsEquivalent).toHaveBeenCalledTimes(1)
    await lookup('rebased-b')
    expect(headIsEquivalent).toHaveBeenCalledTimes(2)
    pages.all = [completed('memo-head-2', 'main')]
    await lookup('rebased-b')
    expect(headIsEquivalent).toHaveBeenCalledTimes(3)
    pages.all = [completed('memo-head-2', 'release')]
    await lookup('rebased-b')
    expect(headIsEquivalent).toHaveBeenCalledTimes(4)
    await lookup('rebased-b', true)
    expect(headIsEquivalent).toHaveBeenCalledTimes(5)
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000 - 60_000)
    await lookup('rebased-b')
    expect(headIsEquivalent).toHaveBeenCalledTimes(5)
    vi.setSystemTime(Date.now() + 60_000)
    await lookup('rebased-b')
    expect(headIsEquivalent).toHaveBeenCalledTimes(6)
  })

  it('keeps a completed PR when the checkout HEAD cannot be read', async () => {
    const requests = serve({ all: [pr(8, 'completed', 'final-head')] })
    readHead.mockResolvedValue(null)
    await expect(getAzureDevOpsPullRequestForBranch('/repo', 'feature/x')).resolves.toMatchObject({
      number: 8,
      state: 'merged'
    })
    expect(requests).toEqual(['all'])
    expect(requestJson).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/\/commits$/),
      expect.anything(),
      expect.anything()
    )
    expect(headIsEquivalent).not.toHaveBeenCalled()
  })

  it('pages PR commits, treats the page cap as proof only, and keeps the PR when commits are unreadable', async () => {
    let completed = pr(4, 'completed', 'final-head')
    const commitsPages: (string | undefined)[] = []
    requestJson.mockImplementation(async (_repo, path: string, options) => {
      if (path.endsWith('/pullRequests')) {
        return { value: [completed] }
      }
      if (!path.endsWith('/commits')) {
        return path.endsWith('/statuses') ? [] : { id: 'repo-id' }
      }
      const token = options.searchParams.continuationToken
      commitsPages.push(token)
      if (path.includes('/5/')) {
        throw new Error('commits unavailable')
      }
      const page = Number(token ?? 0)
      options.onResponse(
        new Response(null, { headers: { 'x-ms-continuationtoken': `${page + 1}` } })
      )
      return { value: [{ commitId: `commit-${page}` }] }
    })
    const lookup = (currentHeadOid: string, throwOnFailure = false, userRefresh = false) =>
      getAzureDevOpsPullRequestForBranch(
        '/repo',
        'feature/x',
        null,
        null,
        { currentHeadOid, userRefresh },
        throwOnFailure
      )
    await expect(lookup('commit-9')).resolves.toMatchObject({ number: 4, state: 'merged' })
    expect(commitsPages).toEqual([undefined, '1', '2', '3', '4', '5', '6', '7', '8', '9'])
    await expect(lookup('commit-10')).resolves.toBeNull()
    expect(commitsPages).toHaveLength(10)

    completed = pr(5, 'completed', 'final-head')
    const merged = { number: 5, state: 'merged' }
    await expect(lookup('earlier-head')).resolves.toMatchObject(merged)
    commitsPages.length = 0
    await expect(lookup('earlier-head', true)).resolves.toMatchObject(merged)
    expect(commitsPages).toEqual([])
    await expect(lookup('earlier-head', true, true)).resolves.toMatchObject(merged)
    expect(commitsPages).toEqual([undefined])
    expect(headIsEquivalent).not.toHaveBeenCalledWith(
      expect.objectContaining({ reviewHeadOid: 'final-head', headOid: 'earlier-head' })
    )
  })

  it('prefers the active PR and asks for it separately only when the recent page is full', async () => {
    const recent = serve({ all: [pr(2, 'completed', 'head'), pr(1, 'active', 'head')] })
    await expect(getAzureDevOpsPullRequestForBranch('/repo', 'feature/x')).resolves.toMatchObject({
      number: 1
    })
    expect(recent).toEqual(['all'])

    const completed = Array.from({ length: 10 }, (_, index) => pr(index + 2, 'completed', 'head'))
    const full = serve({ all: completed, active: [pr(1, 'active', 'head')] })
    await expect(getAzureDevOpsPullRequestForBranch('/repo', 'feature/x')).resolves.toMatchObject({
      number: 1,
      state: 'open'
    })
    expect(full).toEqual(['all', 'active'])
  })
})
