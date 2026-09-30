import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  getBitbucketAuthStatus,
  getBitbucketPullRequestForBranch,
  getBitbucketPullRequestForBranchOrThrow
} from './client'
import { _resetBitbucketRepoRefCache } from './repository-ref'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'

/** Serve the remote URL plus the #9171 default-branch resolver probes. */
function primeGitExecWithDefaultBranch(defaultRef = 'refs/remotes/origin/main'): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote') {
      return { stdout: 'git@bitbucket.org:team/repo.git\n', stderr: '' }
    }
    if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
      return { stdout: `${defaultRef}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify' && args.includes(defaultRef)) {
      return { stdout: 'default-oid\n', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

const OLD_ENV = process.env

function bitbucketPr(id = 7) {
  return {
    id,
    title: 'Add Bitbucket',
    state: 'OPEN',
    updated_on: '2026-05-10T00:00:00.000Z',
    links: { html: { href: `https://bitbucket.org/team/repo/pull-requests/${id}` } },
    source: {
      branch: { name: 'feature/bitbucket' },
      commit: { hash: 'abc123' },
      repository: { full_name: 'team/repo' }
    },
    destination: {
      branch: { name: 'main' },
      repository: { full_name: 'team/repo' }
    }
  }
}

describe('Bitbucket client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_BITBUCKET_API_BASE_URL = 'https://api.test.local/2.0'
    process.env.ORCA_BITBUCKET_EMAIL = 'user@example.com'
    process.env.ORCA_BITBUCKET_API_TOKEN = 'token'
    delete process.env.ORCA_BITBUCKET_ACCESS_TOKEN
    delete process.env.ORCA_BITBUCKET_SERVER_URL
    delete process.env.ORCA_BITBUCKET_SERVER_TOKEN
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git@bitbucket.org:team/repo.git\n',
      stderr: ''
    })
    _resetBitbucketRepoRefCache()
    __resetRepoDefaultBranchCacheForTests()
    vi.unstubAllGlobals()
  })

  it('hides a stale DECLINED PR whose source branch is the repo default branch (#9171)', async () => {
    primeGitExecWithDefaultBranch()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      return Response.json({
        values: [{ ...bitbucketPr(7), state: 'DECLINED', source: { branch: { name: 'main' } } }]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketPullRequestForBranch('/repo', 'refs/heads/main')).resolves.toBeNull()
  })

  it('keeps an OPEN PR whose source branch is the repo default branch', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [{ state: 'SUCCESSFUL' }] })
      }
      return Response.json({
        values: [
          { ...bitbucketPr(8), source: { branch: { name: 'main' }, commit: { hash: 'abc123' } } }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBitbucketPullRequestForBranch('/repo', 'refs/heads/main')
    ).resolves.toMatchObject({ number: 8, state: 'open' })
  })

  it('discards a MERGED default-branch shadow and refetches the linked PR via the fallback (#9171)', async () => {
    primeGitExecWithDefaultBranch()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      if (url.endsWith('/pullrequests/42')) {
        return Response.json(bitbucketPr(42))
      }
      return Response.json({
        values: [{ ...bitbucketPr(7), state: 'MERGED', source: { branch: { name: 'main' } } }]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBitbucketPullRequestForBranch('/repo', 'refs/heads/main', 42)
    ).resolves.toMatchObject({ number: 42 })
  })

  it('hides a MERGED PR matched only by feature-branch name so a new PR can be created', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      return Response.json({
        values: [
          { ...bitbucketPr(7), state: 'MERGED', source: { branch: { name: 'feature/login' } } }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Why: a merged branch match is history. Returning it made eligibility
    // report "a pull request already exists" and blocked the branch's next PR.
    await expect(
      getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/login')
    ).resolves.toBeNull()
  })

  it('keeps a DECLINED PR on a feature branch visible', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      return Response.json({
        values: [
          { ...bitbucketPr(9), state: 'DECLINED', source: { branch: { name: 'feature/login' } } }
        ]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    // Why: only merged matches are hidden. Hiding declined too made a declined
    // PR permanently invisible off the default branch, unlike every other provider.
    await expect(
      getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/login')
    ).resolves.toMatchObject({ number: 9, state: 'closed' })
  })

  it('returns null instead of querying anonymously when no credential resolves', async () => {
    delete process.env.ORCA_BITBUCKET_EMAIL
    delete process.env.ORCA_BITBUCKET_API_TOKEN
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // Why: an unauthenticated query 404s on private repos, which would read as
    // "no pull request" and offer Create for a branch that already has one.
    await expect(
      getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/login')
    ).resolves.toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches an explicitly linked DECLINED PR before the branch index', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/pullrequests/7')) {
        return Response.json({ ...bitbucketPr(7), state: 'DECLINED' })
      }
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      return new Response('branch index unavailable', { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBitbucketPullRequestForBranchOrThrow('/repo', 'refs/heads/feature/login', 7)
    ).resolves.toMatchObject({ number: 7, state: 'closed' })
    expect(fetchMock.mock.calls.map(([url]) => url)).not.toContainEqual(
      expect.stringContaining('/pullrequests?')
    )
  })

  it('falls back to the branch index when a linked PR number is stale', async () => {
    const branchPR = bitbucketPr(7)
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/pullrequests/99')) {
        return new Response('not found', { status: 404 })
      }
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      return Response.json({
        values: [{ ...branchPR, source: { ...branchPR.source, branch: { name: 'feature/login' } } }]
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBitbucketPullRequestForBranchOrThrow('/repo', 'refs/heads/feature/login', 99)
    ).resolves.toMatchObject({ number: 7, state: 'open' })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining('/pullrequests/99'),
      expect.stringContaining('/pullrequests?'),
      expect.stringContaining('/statuses/build')
    ])
  })

  it('does not report an unreachable host as an auth failure (STA-3944)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down')
      })
    )
    await expect(getBitbucketAuthStatus()).resolves.toMatchObject({
      configured: true,
      authenticated: true
    })

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 401 }))
    )
    await expect(getBitbucketAuthStatus()).resolves.toMatchObject({
      configured: true,
      authenticated: false
    })
  })

  it('fetches a branch pull request and commit build status', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [{ state: 'SUCCESSFUL' }] })
      }
      return Response.json({ values: [bitbucketPr()] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/bitbucket')
    ).resolves.toEqual({
      number: 7,
      title: 'Add Bitbucket',
      state: 'open',
      url: 'https://bitbucket.org/team/repo/pull-requests/7',
      status: 'success',
      updatedAt: '2026-05-10T00:00:00.000Z',
      mergeable: 'UNKNOWN',
      headSha: 'abc123'
    })

    const firstCall = fetchMock.mock.calls[0]
    const listUrl = String(firstCall?.[0])
    const listInit = firstCall?.[1]
    if (!listInit) {
      throw new Error('expected request init')
    }
    const parsed = new URL(listUrl)
    expect(parsed.pathname).toBe('/2.0/repositories/team/repo/pullrequests')
    expect(parsed.searchParams.get('q')).toBe(
      'source.branch.name = "feature/bitbucket" AND (state = "OPEN" OR state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")'
    )
    expect(parsed.searchParams.getAll('state')).toEqual([
      'OPEN',
      'MERGED',
      'DECLINED',
      'SUPERSEDED'
    ])
    expect((listInit.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from('user@example.com:token').toString('base64')}`
    )
  })

  it('getBitbucketPullRequestForBranchOrThrow surfaces a failure instead of null (finding 4)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ error: 'forbidden' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    // The swallowing variant collapses a real failure into a false "no PR".
    await expect(getBitbucketPullRequestForBranch('/repo', 'feature/bitbucket')).resolves.toBeNull()
    // The throwing variant makes the failure visible so eligibility records
    // `unavailable` rather than a false "No pull request found".
    await expect(
      getBitbucketPullRequestForBranchOrThrow('/repo', 'feature/bitbucket')
    ).rejects.toThrow(/Bitbucket request failed/)
  })

  it('falls back to a linked PR number when branch lookup misses', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.includes('/statuses/build')) {
        return Response.json({ values: [] })
      }
      if (url.endsWith('/pullrequests/42')) {
        return Response.json(bitbucketPr(42))
      }
      return Response.json({ values: [] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketPullRequestForBranch('/repo', 'different', 42)).resolves.toMatchObject(
      {
        number: 42,
        status: 'neutral'
      }
    )
  })

  it('reports env-token auth status through the Bitbucket /user endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ username: 'bitbucket-user' }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getBitbucketAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: 'bitbucket-user',
      baseUrl: 'https://api.test.local/2.0',
      tokenConfigured: true
    })
  })

  it('cancels unread error-response bodies so bundled undici cannot crash on socket close', async () => {
    let cancelledBodies = 0
    const fetchMock = vi.fn(async () =>
      cancelTrackingResponse(502, () => {
        cancelledBodies += 1
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/bitbucket')

    expect(fetchMock).toHaveBeenCalled()
    expect(cancelledBodies).toBe(fetchMock.mock.calls.length)
  })

  describe('Data Center', () => {
    function serverPr(id = 7) {
      return {
        id,
        title: 'Add Data Center',
        state: 'OPEN',
        updatedDate: Date.parse('2026-05-10T00:00:00.000Z'),
        fromRef: { id: 'refs/heads/feature/dc', displayId: 'feature/dc', latestCommit: 'abc123' },
        toRef: { id: 'refs/heads/main', displayId: 'main' }
      }
    }

    beforeEach(() => {
      process.env.ORCA_BITBUCKET_SERVER_URL = 'https://bb.corp.example/bitbucket'
      process.env.ORCA_BITBUCKET_SERVER_TOKEN = 'pat-123'
      gitExecFileAsyncMock.mockResolvedValue({
        stdout: 'https://bb.corp.example/bitbucket/scm/PRJ/repo.git\n',
        stderr: ''
      })
      _resetBitbucketRepoRefCache()
    })

    it('queries outgoing pull requests by fully-qualified ref and builds the web URL', async () => {
      const fetchMock = vi.fn(async (url: URL, _init?: RequestInit) => {
        if (String(url).includes('/build-status/')) {
          return Response.json({ successful: 2 })
        }
        return Response.json({ values: [serverPr()], isLastPage: true })
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/dc')
      ).resolves.toEqual({
        number: 7,
        title: 'Add Data Center',
        state: 'open',
        url: 'https://bb.corp.example/bitbucket/projects/PRJ/repos/repo/pull-requests/7',
        status: 'success',
        updatedAt: '2026-05-10T00:00:00.000Z',
        mergeable: 'UNKNOWN',
        headSha: 'abc123'
      })

      const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
      expect(listUrl.pathname).toBe('/bitbucket/rest/api/1.0/projects/PRJ/repos/repo/pull-requests')
      expect(listUrl.searchParams.get('at')).toBe('refs/heads/feature/dc')
      // Why: the API defaults to INCOMING, which returns PRs targeting the branch.
      expect(listUrl.searchParams.get('direction')).toBe('OUTGOING')
      expect(listUrl.searchParams.get('state')).toBe('ALL')
      expect(
        (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.headers as Record<string, string>
      ).toMatchObject({ Authorization: 'Bearer pat-123' })

      const statsUrl = new URL(String(fetchMock.mock.calls[1]?.[0]))
      expect(statsUrl.pathname).toBe('/bitbucket/rest/build-status/1.0/commits/stats/abc123')
    })

    it('derives a failing rollup from aggregated build stats', async () => {
      const fetchMock = vi.fn(async (url: URL) =>
        String(url).includes('/build-status/')
          ? Response.json({ successful: 1, failed: 1 })
          : Response.json({ values: [serverPr()] })
      )
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/dc')
      ).resolves.toMatchObject({ status: 'failure' })
    })

    it('surfaces the Data Center error envelope instead of a bare status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          Response.json({ errors: [{ message: 'Project PRJ does not exist.' }] }, { status: 404 })
        )
      )

      await expect(
        getBitbucketPullRequestForBranchOrThrow('/repo', 'refs/heads/feature/dc')
      ).rejects.toThrow('Bitbucket request failed: Project PRJ does not exist.')
    })

    // Why: `Number(null)` is 0, so an absent Retry-After used to pass the
    // wait-budget guard and retry a rate-limited request immediately.
    it('does not retry a 429 that carries no Retry-After header', async () => {
      const fetchMock = vi.fn(async (_url: URL, _init?: RequestInit) =>
        Response.json({ errors: [{ message: 'Too many requests' }] }, { status: 429 })
      )
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/dc')
      ).resolves.toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('retries once when a 429 carries a Retry-After inside the wait budget', async () => {
      let call = 0
      const fetchMock = vi.fn(async (url: URL) => {
        if (String(url).includes('/build-status/')) {
          return Response.json({ successful: 1 })
        }
        call += 1
        return call === 1
          ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
          : Response.json({ values: [serverPr()] })
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(
        getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/dc')
      ).resolves.toMatchObject({ number: 7 })
      expect(call).toBe(2)
    })

    // Why: Number.isFinite admits epochs past ±8.64e15, where toISOString
    // throws RangeError out of the mapper instead of yielding a review.
    it('keeps an out-of-range updatedDate from throwing out of the mapper', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: URL) =>
          String(url).includes('/build-status/')
            ? Response.json({ successful: 1 })
            : Response.json({ values: [{ ...serverPr(), updatedDate: 8.65e15 }] })
        )
      )

      await expect(
        getBitbucketPullRequestForBranch('/repo', 'refs/heads/feature/dc')
      ).resolves.toMatchObject({ number: 7, updatedAt: '' })
    })

    // Why: preflight carries one Bitbucket status, so a stray server token must
    // not blank the card of a working Cloud account. A configured site URL is an
    // unambiguous "I run Data Center" and does take precedence.
    it('keeps reporting Cloud when only a bare server token joins a Cloud setup', async () => {
      delete process.env.ORCA_BITBUCKET_SERVER_URL
      process.env.ORCA_BITBUCKET_SERVER_TOKEN = 'pat-123'
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ username: 'cloud-user' }))
      )

      await expect(getBitbucketAuthStatus()).resolves.toMatchObject({
        account: 'cloud-user',
        baseUrl: 'https://api.test.local/2.0'
      })
    })

    it('lets a configured server site take precedence over Cloud credentials', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response('{"values":[]}', { status: 200, headers: { 'x-ausername': 'dc-user' } })
        )
      )

      await expect(getBitbucketAuthStatus()).resolves.toMatchObject({
        account: 'dc-user',
        baseUrl: 'https://bb.corp.example/bitbucket'
      })
    })

    it('reports auth status from /users with the account name off X-AUSERNAME', async () => {
      const fetchMock = vi.fn(
        async (_url: URL, _init?: RequestInit) =>
          new Response('{"values":[]}', {
            status: 200,
            headers: { 'x-ausername': 'j.smith%40corp.example' }
          })
      )
      vi.stubGlobal('fetch', fetchMock)

      await expect(getBitbucketAuthStatus()).resolves.toEqual({
        configured: true,
        authenticated: true,
        account: 'j.smith@corp.example',
        baseUrl: 'https://bb.corp.example/bitbucket',
        tokenConfigured: true
      })
      expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe(
        '/bitbucket/rest/api/1.0/users'
      )
    })

    it('reports an unauthenticated but reachable site when only a base URL is set', async () => {
      delete process.env.ORCA_BITBUCKET_SERVER_TOKEN
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json({ version: '9.6.0' }))
      )

      await expect(getBitbucketAuthStatus()).resolves.toEqual({
        configured: true,
        authenticated: false,
        account: null,
        baseUrl: 'https://bb.corp.example/bitbucket',
        tokenConfigured: false
      })
    })
  })
})
