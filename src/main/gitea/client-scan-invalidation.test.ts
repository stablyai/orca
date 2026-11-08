import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: vi.fn(async () => ({
    stdout: 'https://git.example.com/team/repo.git\n',
    stderr: ''
  }))
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
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        expect(url.pathname).toBe('/api/v1/repos/team/repo/pulls')
        if (init?.method === 'POST') {
          created = true
          return Response.json(pullRequest)
        }
        return Response.json(created ? [pullRequest] : [])
      })
    )

    // The empty head= page is a definitive miss shared by both modes.
    expect(await getGiteaPullRequestForBranch('/repo', branch)).toBeNull()
    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toBeNull()
    expect(await createReview()).toMatchObject({ ok: true, number: 7 })

    // Invalidation drops the miss so the four readers re-fetch and coalesce
    // on the created PR.
    const refreshed = await Promise.all([
      getGiteaPullRequestForBranchOrThrow('/repo', branch),
      getGiteaPullRequestForBranchOrThrow('/repo', branch),
      getGiteaPullRequestForBranch('/repo', branch),
      getGiteaPullRequestForBranch('/repo', branch)
    ])
    expect(refreshed.map((review) => review?.number)).toEqual([7, 7, 7, 7])
    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toMatchObject({ number: 7 })
  })

  it('retires a strict miss when a create attempt recovers an existing pull request', async () => {
    let attempted = false
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) => {
        if (init?.method === 'POST') {
          attempted = true
          return Response.json({ message: 'already exists' }, { status: 409 })
        }
        return Response.json(attempted ? [pullRequest] : [])
      })
    )

    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toBeNull()
    expect(await createReview()).toMatchObject({
      ok: false,
      code: 'already_exists',
      existingReview: { number: 7 }
    })
    // The invalidation retires the miss: the lookup re-probes and recovers
    // the existing PR, and the final read comes from the probe cache.
    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toMatchObject({ number: 7 })
  })

  it('re-fetches after an invalidation instead of replaying a strict miss', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json([]))
        .mockResolvedValueOnce(Response.json([pullRequest]))
    )

    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toBeNull()
    const repo = await getGiteaRepoSlug('/repo')
    if (!repo) {
      throw new Error('Expected test repository')
    }
    invalidateGiteaPullRequestScanForRepo(repo)

    // The invalidation retires the strict miss: the lookup re-fetches and
    // recovers the existing PR instead of replaying the miss. The concurrent
    // race-window variants live in client.test.ts (in-flight re-cache pin).
    expect(await getGiteaPullRequestForBranchOrThrow('/repo', branch)).toMatchObject({ number: 7 })
  })
})
