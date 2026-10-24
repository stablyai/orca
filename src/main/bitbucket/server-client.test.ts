import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, baseUrlMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  baseUrlMock: vi.fn<() => string | null>()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./server-auth-config', async (importActual) => ({
  ...(await importActual<typeof ServerAuthConfig>()),
  getBitbucketServerBaseUrl: baseUrlMock
}))

import type * as ServerAuthConfig from './server-auth-config'
import {
  getBitbucketServerPullRequest,
  getBitbucketServerPullRequestForBranch,
  getBitbucketServerPullRequestForBranchOrThrow
} from './server-client'
import { _resetBitbucketServerRepoRefCache } from './server-repository-ref'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'

const OLD_ENV = process.env
const BASE = 'https://bitbucket.example.com'
const REPO_API = `${BASE}/rest/api/1.0/projects/prj/repos/repo`

function serverPr(id = 12, state = 'OPEN', branch = 'feat') {
  return {
    id,
    title: 'Add server support',
    state,
    updatedDate: 1792460776769,
    fromRef: { id: `refs/heads/${branch}`, displayId: branch, latestCommit: 'abc123' },
    toRef: { id: 'refs/heads/main', displayId: 'main', latestCommit: 'def456' },
    reviewers: [{ user: { name: 'bob' }, status: 'UNAPPROVED' }],
    links: { self: [{ href: `${BASE}/projects/PRJ/repos/repo/pull-requests/${id}` }] }
  }
}

function routeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string, _init?: RequestInit) => {
    const key = Object.keys(routes).find((prefix) => url.startsWith(prefix))
    if (!key) {
      throw new Error(`unexpected fetch: ${url}`)
    }
    return routes[key]()
  })
}

describe('Bitbucket Server client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_BITBUCKET_SERVER_BASE_URL = BASE
    process.env.ORCA_BITBUCKET_SERVER_TOKEN = 't0k'
    baseUrlMock.mockReturnValue(BASE)
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: `${BASE}/scm/prj/repo.git\n`, stderr: '' })
    _resetBitbucketServerRepoRefCache()
    __resetRepoDefaultBranchCacheForTests()
    vi.unstubAllGlobals()
  })

  it('finds the open PR for a branch with build status and merge check', async () => {
    const fetchMock = routeFetch({
      [`${REPO_API}/pull-requests?`]: () => Response.json({ size: 1, values: [serverPr()] }),
      [`${REPO_API}/pull-requests/12/merge`]: () =>
        Response.json({ canMerge: true, conflicted: false, outcome: 'CLEAN', vetoes: [] }),
      [`${BASE}/rest/build-status/1.0/commits/stats/abc123`]: () =>
        Response.json({ successful: 1, inProgress: 0, failed: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBitbucketServerPullRequestForBranch('/repo', 'refs/heads/feat')
    ).resolves.toMatchObject({
      number: 12,
      state: 'open',
      status: 'success',
      mergeable: 'MERGEABLE',
      reviewDecision: 'REVIEW_REQUIRED'
    })
    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(`${listUrl.origin}${listUrl.pathname}`).toBe(`${REPO_API}/pull-requests`)
    expect(Object.fromEntries(listUrl.searchParams)).toEqual({
      state: 'ALL',
      direction: 'OUTGOING',
      at: 'refs/heads/feat',
      order: 'NEWEST',
      limit: '1'
    })
    const [, init] = fetchMock.mock.calls[0] ?? []
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer t0k' })
  })

  it('returns null when the branch has no PR', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ [`${REPO_API}/pull-requests?`]: () => Response.json({ size: 0, values: [] }) })
    )

    await expect(getBitbucketServerPullRequestForBranch('/repo', 'no-such')).resolves.toBeNull()
  })

  it('hides a merged PR matched only by branch name', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [`${REPO_API}/pull-requests?`]: () =>
          Response.json({ size: 1, values: [serverPr(5, 'MERGED', 'release')] }),
        [`${BASE}/rest/build-status`]: () =>
          Response.json({ successful: 0, inProgress: 0, failed: 0 })
      })
    )

    await expect(getBitbucketServerPullRequestForBranch('/repo', 'release')).resolves.toBeNull()
  })

  it('falls back to the branch lookup when the linked PR is gone', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [`${REPO_API}/pull-requests/99999999`]: () => new Response('{}', { status: 404 }),
        [`${REPO_API}/pull-requests?`]: () => Response.json({ size: 1, values: [serverPr()] }),
        [`${REPO_API}/pull-requests/12/merge`]: () => Response.json({ outcome: 'CLEAN' }),
        [`${BASE}/rest/build-status`]: () =>
          Response.json({ successful: 0, inProgress: 0, failed: 0 })
      })
    )

    await expect(
      getBitbucketServerPullRequestForBranchOrThrow('/repo', 'feat', 99999999)
    ).resolves.toMatchObject({ number: 12 })
  })

  it('skips the merge check for non-open PRs', async () => {
    const fetchMock = routeFetch({
      [`${REPO_API}/pull-requests/5`]: () => Response.json(serverPr(5, 'DECLINED')),
      [`${BASE}/rest/build-status`]: () =>
        Response.json({ successful: 0, inProgress: 0, failed: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketServerPullRequest('/repo', 5)).resolves.toMatchObject({
      state: 'closed',
      mergeable: 'UNKNOWN'
    })
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/merge'))).toBe(false)
  })

  it('keeps the PR when merge check and build status fail', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({
        [`${REPO_API}/pull-requests/12/merge`]: () => new Response('', { status: 500 }),
        [`${REPO_API}/pull-requests/12`]: () => Response.json(serverPr()),
        [`${BASE}/rest/build-status`]: () => new Response('', { status: 500 })
      })
    )

    await expect(getBitbucketServerPullRequest('/repo', 12)).resolves.toMatchObject({
      number: 12,
      status: 'neutral',
      mergeable: 'UNKNOWN'
    })
  })

  it('throws on 401 only when asked to, without leaking the token', async () => {
    vi.stubGlobal(
      'fetch',
      routeFetch({ [`${REPO_API}/pull-requests?`]: () => new Response('', { status: 401 }) })
    )

    await expect(getBitbucketServerPullRequestForBranch('/repo', 'feat')).resolves.toBeNull()
    const error = await getBitbucketServerPullRequestForBranchOrThrow('/repo', 'feat').catch(
      (caught: unknown) => caught
    )
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('HTTP 401')
    expect(String(error)).not.toContain('t0k')
  })

  it('returns null for a repo that is not on the registered server', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@bitbucket.org:team/repo.git\n',
      stderr: ''
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketServerPullRequestForBranch('/repo', 'feat')).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
