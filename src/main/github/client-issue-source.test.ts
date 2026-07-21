import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GhUtils from './gh-utils'

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  resolveIssueSourceMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  resolvePRRepositoryCandidatesMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    execFileAsync: execFileAsyncMock,
    ghExecFileAsync: ghExecFileAsyncMock,
    getOwnerRepo: getOwnerRepoMock,
    getIssueOwnerRepo: getIssueOwnerRepoMock,
    getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock,
    _resetOwnerRepoCache: vi.fn()
  }
})

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: () => true
}))

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  return {
    ...actual,
    // Why: these suites drive source resolution through the legacy gh-utils
    // mocks; bridge the hosted seams onto the same mocks.
    resolveIssueGitHubApiRepositorySource: (
      repoPath: string,
      preference: unknown,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolveIssueSourceMock(repoPath, preference, connectionId, localGitOptions),
    getIssueGitHubApiRepository: (repoPath: string, connectionId?: string | null) =>
      getIssueOwnerRepoMock(repoPath, connectionId),
    getOriginGitHubApiRepository: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => getOwnerRepoMock(repoPath, connectionId, localGitOptions),
    getGitHubApiRepositoryForRemote: (
      repoPath: string,
      remoteName: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) =>
      remoteName === 'origin'
        ? getOwnerRepoMock(repoPath, connectionId, localGitOptions)
        : getOwnerRepoForRemoteMock(repoPath, remoteName, connectionId, localGitOptions),
    resolveGitHubApiRepositoryCandidates: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolvePRRepositoryCandidatesMock(repoPath, connectionId, localGitOptions)
  }
})

import { countWorkItems, getWorkItem, listWorkItems, _resetOwnerRepoCache } from './client'

const PR_LIST_FIELDS =
  'number,title,state,url,labels,updatedAt,author,isDraft,headRefName,baseRefName,headRefOid,headRepositoryOwner,reviewRequests'

function issueSearchArgs(
  ownerRepo: string,
  options: { noCache?: boolean; query?: string } = {}
): string[] {
  const query = options.query ?? 'is:issue is:open'
  return [
    'api',
    ...(options.noCache ? [] : ['--cache', '120s']),
    `search/issues?q=${encodeURIComponent(`repo:${ownerRepo} ${query}`)}&sort=created&order=desc&per_page=10&page=1`,
    '--jq',
    '.items'
  ]
}

function prListArgs(ownerRepo: string, query = 'is:pr is:open'): string[] {
  return [
    'pr',
    'list',
    '--limit',
    '10',
    '--state',
    'all',
    '--json',
    PR_LIST_FIELDS,
    '--repo',
    ownerRepo,
    '--search',
    `${query} sort:created-desc`
  ]
}

function decodedIssueSearchPath(callIndex: number): string {
  const args = ghExecFileAsyncMock.mock.calls[callIndex]?.[0] as string[] | undefined
  const apiPath = args?.find((arg) => arg.startsWith('search/issues?'))
  expect(apiPath).toBeDefined()
  return decodeURIComponent(apiPath ?? '')
}

// Route resolvePrWorkItemSource's per-remote probes: origin delegates to
// getOwnerRepoMock (so existing tests keep defining origin through it) and
// upstream returns the given candidate.
function mockUpstreamCandidate(upstream: { owner: string; repo: string } | null): void {
  getOwnerRepoForRemoteMock.mockImplementation(
    async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
      remoteName === 'upstream' ? upstream : getOwnerRepoMock(repoPath, connectionId, opts)
  )
}

describe('GitHub issue source split', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    resolvePRRepositoryCandidatesMock.mockReset()
    resolveIssueSourceMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    // Why: default the preference-aware resolver to 'auto' semantics so the
    // pre-existing test cases (which don't think about preference at all)
    // still pass. `listWorkItems` now calls `resolveIssueSource` instead of
    // `getIssueOwnerRepo` directly — we delegate back to the single-call
    // mock to preserve the one-fetch-per-test invariant each test sets up.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
    // Why: keep origin on the legacy mock while hosted candidate tests opt in
    // to upstream behavior explicitly.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
      const origin = await getOwnerRepoMock(repoPath, connectionId)
      const repository = origin ? { host: 'github.com', ...origin } : null
      return { candidates: repository ? [repository] : [], headRepo: repository }
    })
    _resetOwnerRepoCache()
  })

  it('uses upstream for issues and origin for PRs in mixed recent results', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 923,
            title: 'Use upstream issues',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/issues/923',
            labels: [],
            updated_at: '2026-04-01T00:00:00Z',
            user: { login: 'octocat' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Fork PR',
            state: 'open',
            html_url: 'https://github.com/fork/orca/pull/42',
            labels: [],
            updated_at: '2026-03-31T00:00:00Z',
            user: { login: 'octocat' },
            draft: false,
            head: { ref: 'feature' },
            base: { ref: 'main' }
          }
        ])
      })

    await listWorkItems('/repo-root', 10)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(1, issueSearchArgs('stablyai/orca'), {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, prListArgs('fork/orca'), {
      cwd: '/repo-root'
    })
  })

  it('omits gh api cache args for no-cache recent work-item requests', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
      stdout: '[]'
    })

    await listWorkItems('/repo-root', 10, undefined, undefined, undefined, undefined, true)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      issueSearchArgs('stablyai/orca', { noCache: true }),
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, prListArgs('fork/orca'), {
      cwd: '/repo-root'
    })
  })

  it('lists SSH repo work items with explicit owner/repo and no local cwd', async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
      stdout: '[]'
    })

    await listWorkItems('/home/jinwoo/orca', 10, undefined, undefined, 'auto', 'openclaw-2')

    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/home/jinwoo/orca',
      'auto',
      'openclaw-2',
      {}
    )
    expect(getOwnerRepoMock).toHaveBeenCalledWith('/home/jinwoo/orca', 'openclaw-2', {})
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(1, issueSearchArgs('stablyai/orca'), {})
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, prListArgs('fork/orca'), {})
  })

  it('uses upstream for issue-only queries and origin for PR-only queries', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'is:issue')

    expect(decodedIssueSearchPath(0)).toContain('q=repo:stablyai/orca is:issue')

    ghExecFileAsyncMock.mockClear()
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'is:pr')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--repo', 'fork/orca']),
      { cwd: '/repo-root' }
    )
  })

  it.each(['is:issue', 'is:pr'])(
    'propagates GitHub outages for scoped %s queries',
    async (query) => {
      getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))

      await expect(listWorkItems('/repo-root', 10, query)).rejects.toThrow(
        'HTTP 503: Service Unavailable'
      )

      // The outage signal reuses the failed request; it must not add retry subprocesses.
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    }
  )

  it('propagates an outage when both sides of a combined query are unavailable', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))
      .mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))

    await expect(listWorkItems('/repo-root', 10, 'is:open')).rejects.toThrow(
      'HTTP 503: Service Unavailable'
    )

    // Classification must reuse the issue and PR requests, not retry the outage.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it("uses upstream for recent PRs when preference='upstream'", async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    mockUpstreamCandidate({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
      stdout: '[]'
    })

    await listWorkItems('/repo-root', 10, undefined, undefined, 'upstream')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, prListArgs('stablyai/orca'), {
      cwd: '/repo-root'
    })
  })

  it("uses upstream for queried PRs when preference='upstream'", async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    mockUpstreamCandidate({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await listWorkItems('/repo-root', 10, 'is:pr is:open', undefined, 'upstream')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--repo', 'stablyai/orca']),
      { cwd: '/repo-root' }
    )
  })

  it("uses upstream for PR counts when preference='upstream'", async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    mockUpstreamCandidate({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '9\n' })

    const count = await countWorkItems('/repo-root', 'is:pr is:open', 'upstream')

    expect(count).toBe(9)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent('repo:stablyai/orca is:pull-request is:open')}&per_page=1`,
        '--jq',
        '.total_count'
      ],
      { cwd: '/repo-root' }
    )
  })

  it("falls back to origin for PRs when preference='upstream' and upstream is missing", async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({
      source: { owner: 'fork', repo: 'orca' },
      fellBack: true
    })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    // beforeEach default: upstream probe resolves null, origin delegates to
    // getOwnerRepoMock.
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    const result = await listWorkItems('/repo-root', 10, 'is:pr', undefined, 'upstream')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.arrayContaining(['--repo', 'fork/orca']),
      { cwd: '/repo-root' }
    )
    expect(result.sources).toEqual({
      issues: { owner: 'fork', repo: 'orca' },
      prs: { owner: 'fork', repo: 'orca' },
      originCandidate: { owner: 'fork', repo: 'orca' },
      upstreamCandidate: null
    })
    expect(result.issueSourceFellBack).toBe(true)
  })

  it('counts default work items across upstream issues and origin PRs', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '7\n' })
      .mockResolvedValueOnce({ stdout: '5\n' })

    const count = await countWorkItems('/repo-root')

    expect(count).toBe(12)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent('repo:stablyai/orca is:issue is:open')}&per_page=1`,
        '--jq',
        '.total_count'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        '--cache',
        '120s',
        `search/issues?q=${encodeURIComponent('repo:fork/orca is:pull-request is:open')}&per_page=1`,
        '--jq',
        '.total_count'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('typed PR lookup does not fetch an upstream issue with the same number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Origin PR',
        state: 'open',
        html_url: 'https://github.com/fork/orca/pull/42',
        labels: [],
        updated_at: '2026-04-02T00:00:00Z',
        user: { login: 'octocat' },
        draft: false,
        head: { ref: 'feature' },
        base: { ref: 'main' }
      })
    })

    const item = await getWorkItem('/repo-root', 42, 'pr')

    expect(getIssueOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '42',
        '--repo',
        'fork/orca',
        '--json',
        expect.stringContaining('reviewDecision')
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(item?.type).toBe('pr')
  })

  it('probes the upstream repository for a typed fork PR before origin', async () => {
    const upstream = { owner: 'stablyai', repo: 'orca', host: 'github.com' }
    const origin = { owner: 'fork', repo: 'orca', host: 'github.com' }
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [upstream, origin],
      headRepo: origin
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Upstream PR',
        state: 'open',
        url: 'https://github.com/stablyai/orca/pull/42',
        labels: [],
        updatedAt: '2026-04-02T00:00:00Z',
        author: { login: 'octocat' },
        isDraft: false
      })
    })

    const item = await getWorkItem('/repo-root', 42, 'pr')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '42',
        '--repo',
        'stablyai/orca',
        '--json',
        expect.stringContaining('reviewDecision')
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(item?.prRepo).toEqual(upstream)
  })

  it('does not run a bare gh lookup for an SSH repo without candidates', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({ candidates: [], headRepo: null })

    await expect(getWorkItem('/remote/repo', 42, 'pr', 'ssh-1')).resolves.toBeNull()

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not probe a second PR repository after a non-not-found failure', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca', host: 'github.com' },
        { owner: 'fork', repo: 'orca', host: 'github.com' }
      ],
      headRepo: { owner: 'fork', repo: 'orca', host: 'github.com' }
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 500: server error'))
      .mockRejectedValueOnce(new Error('HTTP 500: server error'))

    await expect(getWorkItem('/repo-root', 42, 'pr')).resolves.toBeNull()

    // The first candidate uses `pr view` and its REST compatibility fallback;
    // neither failure is a 404, so a same-number PR on origin is never queried.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(
      ghExecFileAsyncMock.mock.calls.some(([args]) =>
        (args as string[]).some((arg) => arg.includes('fork/orca'))
      )
    ).toBe(false)
  })

  it('raw number lookup tries upstream issue before origin PR', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    // Why: simulate a real gh 404 (the only error type that should fall through).
    // Non-404 errors re-throw so transient upstream failures don't misroute to an
    // unrelated origin PR with the same number.
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Origin PR',
        state: 'open',
        html_url: 'https://github.com/fork/orca/pull/42',
        labels: [],
        updated_at: '2026-04-02T00:00:00Z',
        user: { login: 'octocat' },
        draft: false
      })
    })

    const item = await getWorkItem('/repo-root', 42)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/stablyai/orca/issues/42'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'view',
        '42',
        '--repo',
        'fork/orca',
        '--json',
        expect.stringContaining('reviewDecision')
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(item?.type).toBe('pr')
  })

  it('surfaces a 403 from upstream issues through the listWorkItems envelope', async () => {
    // Why: parent design doc §3 / acceptance criterion 2 — the IPC envelope
    // must carry a classified error for the failing side so the renderer can
    // swap the empty-state for a retryable banner. `sources` must stay
    // populated so the banner copy can name the repo that failed.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 403: Resource not accessible by integration'))
      .mockResolvedValueOnce({ stdout: '[]' })

    const result = await listWorkItems('/repo-root', 10)

    expect(result.items).toEqual([])
    expect(result.sources).toMatchObject({
      issues: { owner: 'stablyai', repo: 'orca' },
      prs: { owner: 'fork', repo: 'orca' }
    })
    expect(result.errors?.issues?.type).toBe('permission_denied')
  })

  it('returns partial results when upstream issues fail but origin PRs succeed', async () => {
    // Why: parent design doc §2 partial-failure rule — a failing source must
    // not zero out the succeeding source. The UI renders origin PRs with a
    // banner above the list, not an empty state. Ensures the IPC shape
    // carries both the successful items and the error for the failing side.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 403: Resource not accessible by integration'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Fork PR',
            state: 'open',
            html_url: 'https://github.com/fork/orca/pull/42',
            labels: [],
            updated_at: '2026-03-31T00:00:00Z',
            user: { login: 'octocat' },
            draft: false,
            head: { ref: 'feature' },
            base: { ref: 'main' }
          }
        ])
      })

    const result = await listWorkItems('/repo-root', 10)

    expect(result.items.map((i) => i.id)).toEqual(['pr:42'])
    expect(result.errors?.issues?.type).toBe('permission_denied')
  })

  it('raw number lookup does not fall through on transient upstream errors', async () => {
    // Why: with issue source split, a non-404 upstream failure must not silently
    // route to origin's PR #N — that would return an unrelated item.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 500: server error'))

    const item = await getWorkItem('/repo-root', 42)

    expect(item).toBeNull()
    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  describe('per-repo issue-source preference', () => {
    // Why: 3 preference states × 2 remote-topology states = 6 cases per the
    // design doc §9. These tests isolate `listWorkItems` against a mocked
    // `resolveIssueSource` to verify the preference is threaded all the way
    // to the gh call and that `fellBack` propagates into the envelope.

    it("preference='auto' + upstream exists → queries upstream", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'stablyai', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'auto')

      expect(resolveIssueSourceMock).toHaveBeenCalledWith('/repo-root', 'auto', undefined, {})
      expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(1, issueSearchArgs('stablyai/orca'), {
        cwd: '/repo-root'
      })
      expect(result.issueSourceFellBack).toBeUndefined()
    })

    it("preference='auto' + no upstream → queries origin", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'solo', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'solo', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      await listWorkItems('/repo-root', 10, undefined, undefined, 'auto')

      expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(1, issueSearchArgs('solo/orca'), {
        cwd: '/repo-root'
      })
    })

    it("preference='upstream' + upstream exists → queries upstream", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'stablyai', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'upstream')

      expect(decodedIssueSearchPath(0)).toContain('q=repo:stablyai/orca is:issue is:open')
      expect(result.issueSourceFellBack).toBeUndefined()
    })

    it("preference='upstream' + no upstream → falls back to origin with fellBack=true", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'solo', repo: 'orca' },
        fellBack: true
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'solo', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'upstream')

      expect(decodedIssueSearchPath(0)).toContain('q=repo:solo/orca is:issue is:open')
      expect(result.issueSourceFellBack).toBe(true)
    })

    it("preference='origin' + upstream exists → queries origin (not upstream)", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'fork', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      await listWorkItems('/repo-root', 10, undefined, undefined, 'origin')

      expect(decodedIssueSearchPath(0)).toContain('q=repo:fork/orca is:issue is:open')
    })

    it("preference='origin' + no upstream → queries origin", async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'solo', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'solo', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      await listWorkItems('/repo-root', 10, undefined, undefined, 'origin')

      expect(decodedIssueSearchPath(0)).toContain('q=repo:solo/orca is:issue is:open')
    })

    it('surfaces upstreamCandidate in sources regardless of effective preference', async () => {
      // Why: the renderer selector needs to keep rendering after the user picks
      // 'origin'. That requires the envelope to carry the raw upstream even
      // when `sources.issues` has collapsed onto origin.
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'fork', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      mockUpstreamCandidate({ owner: 'stablyai', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'origin')

      expect(result.sources).toEqual({
        issues: { owner: 'fork', repo: 'orca' },
        prs: { owner: 'fork', repo: 'orca' },
        originCandidate: { owner: 'fork', repo: 'orca' },
        upstreamCandidate: { owner: 'stablyai', repo: 'orca' }
      })
    })

    it('keeps raw origin metadata when effective PR source is upstream', async () => {
      resolveIssueSourceMock.mockResolvedValueOnce({
        source: { owner: 'stablyai', repo: 'orca' },
        fellBack: false
      })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      mockUpstreamCandidate({ owner: 'stablyai', repo: 'orca' })
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' }).mockResolvedValueOnce({
        stdout: '[]'
      })

      const result = await listWorkItems('/repo-root', 10, undefined, undefined, 'upstream')

      expect(result.sources).toEqual({
        issues: { owner: 'stablyai', repo: 'orca' },
        prs: { owner: 'stablyai', repo: 'orca' },
        originCandidate: { owner: 'fork', repo: 'orca' },
        upstreamCandidate: { owner: 'stablyai', repo: 'orca' }
      })
    })
  })
})
