import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GhUtils from './gh-utils'

// Keep legacy REST request/failure coverage; API-boundary suites exercise the GraphQL path.
vi.mock('./client/list/work-item-search-page', () => ({ usesGraphqlWorkItemSearch: () => false }))

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
    // Bridge hosted source resolution to the existing gh-utils fixtures.
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
import { getWorkItem } from './client/fetch/get-work-item'
import { listWorkItems } from './client/list/list-work-items'
import { _resetOwnerRepoCache } from './gh-utils'

// Share origin fixtures while letting candidate tests opt into upstream.
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
    // Preserve one source lookup per test while exercising the preference-aware resolver.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
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

  it.each(['is:issue', 'is:pr'])(
    'propagates GitHub outages for scoped %s queries',
    async (query) => {
      getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
      getOwnerRepoMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
      ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))

      await expect(listWorkItems('/repo-root', 10, query)).rejects.toThrow(
        'HTTP 503: Service Unavailable'
      )

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

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('pins typed PR metadata to explicit origin when upstream has the same number', async () => {
    const upstream = { owner: 'stablyai', repo: 'orca', host: 'github.com' }
    const origin = { owner: 'fork', repo: 'orca', host: 'github.com' }
    getOwnerRepoMock.mockResolvedValue(origin)
    mockUpstreamCandidate(upstream)
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [upstream, origin],
      headRepo: origin
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Origin PR',
        state: 'open',
        url: 'https://github.com/fork/orca/pull/42',
        labels: [],
        updatedAt: '2026-04-02T00:00:00Z',
        author: { login: 'octocat' },
        isDraft: false,
        headRefName: 'origin/fix',
        baseRefName: 'main'
      })
    })

    const item = await getWorkItem('/repo-root', 42, 'pr', null, {}, 'origin')

    expect(resolvePRRepositoryCandidatesMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['pr', 'view', '--repo', 'fork/orca'])
    )
    expect(
      ghExecFileAsyncMock.mock.calls.some((call) =>
        (call[0] as string[]).some((arg) => arg.includes('upstream/orca'))
      )
    ).toBe(false)
    expect(item?.prRepo).toEqual(origin)
  })

  it('does not run a bare PR lookup when explicit origin identity is unresolved', async () => {
    getOwnerRepoMock.mockResolvedValue(null)
    mockUpstreamCandidate({ owner: 'stablyai', repo: 'orca' })

    await expect(getWorkItem('/repo-root', 42, 'pr', null, {}, 'origin')).resolves.toBeNull()

    expect(resolvePRRepositoryCandidatesMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
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

    // Only a confirmed 404 permits trying a same-number PR on another repository.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(
      ghExecFileAsyncMock.mock.calls.some(([args]) =>
        (args as string[]).some((arg) => arg.includes('fork/orca'))
      )
    ).toBe(false)
  })

  it('raw number lookup tries upstream issue before origin PR', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    // Non-404 upstream failures must not route to an unrelated origin PR with the same number.
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

  it('returns partial results when upstream issues fail but origin PRs succeed', async () => {
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
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 500: server error'))

    const item = await getWorkItem('/repo-root', 42)

    expect(item).toBeNull()
    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })
})
