import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../git/runner', () => ({
  gitExecFileAsync: vi.fn(async () => ({
    stdout: 'https://git.example.com/team/repo.git\n',
    stderr: ''
  }))
}))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSSHGitProvider: vi.fn(() => undefined),
  getSSHGitProviderGeneration: () => 0
}))
vi.mock('../source-control/pull-request-template', () => ({
  readHostedPullRequestTemplate: vi.fn(async () => '')
}))

import {
  getGiteaPullRequestForBranch,
  getGiteaPullRequestForBranchOrThrow,
  getGiteaRepoSlug,
  invalidateGiteaPullRequestScanForRepo
} from './client'
import { createGiteaPullRequest } from './pull-request-creation'
import { _resetGiteaRepoRefCache } from './repository-ref'
import { _resetGiteaPullRequestScanCache } from './pull-request-scan-cache'

const branch = 'feature/gitea'
const pullRequest = {
  number: 7,
  title: 'Add Gitea',
  state: 'open',
  html_url: 'https://git.example.com/team/repo/pulls/7',
  head: { ref: branch }
}

function createReview() {
  return createGiteaPullRequest(
    '/repo',
    { provider: 'gitea', base: 'main', head: branch, title: 'Add Gitea', body: '' },
    'local'
  )
}

describe('Gitea scan invalidation after creation', () => {
  beforeEach(() => {
    vi.stubEnv('ORCA_GITEA_TOKEN', 'test-token')
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', '')
    _resetGiteaRepoRefCache()
    _resetGiteaPullRequestScanCache()
  })

  afterEach(() => {
    _resetGiteaRepoRefCache()
    _resetGiteaPullRequestScanCache()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('refreshes cached misses in both modes after a successful create and coalesces readers', async () => {
    let created = false
    let listCalls = 0
    let createCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        expect(url.pathname).toBe('/api/v1/repos/team/repo/pulls')
        if (init?.method === 'POST') {
          createCalls++
          created = true
          return Response.json(pullRequest)
        }
        listCalls++
        return Response.json(created ? [pullRequest] : [])
      })
    )

    expect(await getGiteaPullRequestForBranch('/repo', branch)).toBeNull()
    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toBeNull()
    expect(listCalls).toBe(2)
    expect(await createReview()).toMatchObject({ ok: true, number: 7 })

    const refreshed = await Promise.all([
      getGiteaPullRequestForBranchOrThrow('/repo', branch),
      getGiteaPullRequestForBranchOrThrow('/repo', branch),
      getGiteaPullRequestForBranch('/repo', branch),
      getGiteaPullRequestForBranch('/repo', branch)
    ])
    expect(refreshed.map((review) => review?.number)).toEqual([7, 7, 7, 7])
    expect(listCalls).toBe(4)
    expect(createCalls).toBe(1)
    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toMatchObject({ number: 7 })
    expect(listCalls).toBe(4)
  })

  it('retires a strict miss when a create attempt recovers an existing pull request', async () => {
    let attempted = false
    let listCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          attempted = true
          return Response.json({ message: 'already exists' }, { status: 409 })
        }
        listCalls++
        return Response.json(attempted ? [pullRequest] : [])
      })
    )

    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toBeNull()
    expect(await createReview()).toMatchObject({
      ok: false,
      code: 'already_exists',
      existingReview: { number: 7 }
    })
    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toMatchObject({ number: 7 })
    expect(listCalls).toBe(3)
  })

  it.each(['before', 'after'] as const)(
    'keeps fresh strict results when a pre-invalidation scan finishes %s its replacement',
    async (completionOrder) => {
      const oldResponse = Promise.withResolvers<Response>()
      const freshResponse = Promise.withResolvers<Response>()
      const oldStarted = Promise.withResolvers<void>()
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => {
          oldStarted.resolve()
          return oldResponse.promise
        })
        .mockImplementationOnce(() => freshResponse.promise)
      vi.stubGlobal('fetch', fetchMock)

      const stale = getGiteaPullRequestForBranchOrThrow('/repo', branch)
      await oldStarted.promise
      const repo = await getGiteaRepoSlug('/repo')
      if (!repo) {
        throw new Error('Expected test repository')
      }
      invalidateGiteaPullRequestScanForRepo(repo)
      const fresh = getGiteaPullRequestForBranchOrThrow('/repo', branch)
      const concurrent = getGiteaPullRequestForBranchOrThrow('/repo', branch)
      try {
        await new Promise<void>((resolve) => setImmediate(resolve))
        expect(fetchMock).toHaveBeenCalledTimes(2)
        if (completionOrder === 'before') {
          oldResponse.resolve(Response.json([]))
          expect(await stale).toBeNull()
        }
        freshResponse.resolve(Response.json([pullRequest]))
        expect(await fresh).toMatchObject({ number: 7 })
        expect(await concurrent).toMatchObject({ number: 7 })
        if (completionOrder === 'after') {
          oldResponse.resolve(Response.json([]))
          expect(await stale).toBeNull()
        }
        expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toMatchObject({
          number: 7
        })
        expect(fetchMock).toHaveBeenCalledTimes(2)
      } finally {
        oldResponse.resolve(Response.json([]))
        freshResponse.resolve(Response.json([pullRequest]))
        await Promise.all([stale, fresh, concurrent])
      }
    }
  )
})
