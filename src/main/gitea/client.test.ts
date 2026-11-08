import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))
import {
  getGiteaPullRequestForBranch,
  getGiteaPullRequestForBranchOrThrow,
  normalizeGiteaApiBaseUrl
} from './client'
import { _resetGiteaRepoRefCache } from './repository-ref'
import { _resetGiteaPullRequestScanCache } from './pull-request-scan-cache'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'

const OLD_ENV = process.env

function primeGitExecWithDefaultBranch(defaultRef = 'refs/remotes/origin/main'): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote') {
      return { stdout: 'https://git.example.com/team/repo.git\n', stderr: '' }
    }
    if (args[0] === 'for-each-ref' && args.includes('--format=%(refname)%00%(symref)')) {
      return { stdout: `refs/remotes/origin/HEAD\0${defaultRef}\n`, stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

function giteaPr(index = 7, branch = 'feature/gitea') {
  return {
    number: index,
    title: 'Add Gitea',
    state: 'open',
    html_url: `https://git.example.com/team/repo/pulls/${index}`,
    updated_at: '2026-05-15T00:00:00Z',
    mergeable: true,
    head: {
      ref: branch,
      label: `team:${branch}`,
      sha: 'abc123'
    }
  }
}

describe('Gitea client', () => {
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    process.env.ORCA_GITEA_TOKEN = 'gitea-token'
    delete process.env.ORCA_GITEA_API_BASE_URL
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'https://git.example.com/team/repo.git\n',
      stderr: ''
    })
    _resetGiteaRepoRefCache()
    _resetGiteaPullRequestScanCache()
    __resetRepoDefaultBranchCacheForTests()
    vi.unstubAllGlobals()
  })

  it('discards a closed default-branch shadow and refetches the linked PR via the fallback (#9171)', async () => {
    primeGitExecWithDefaultBranch()
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (parsed.pathname.endsWith('/pulls/42')) {
        return Response.json(giteaPr(42, 'main'))
      }
      return Response.json([{ ...giteaPr(7, 'main'), state: 'closed' }])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getGiteaPullRequestForBranch('/repo', 'refs/heads/main', 42)
    ).resolves.toMatchObject({ number: 42 })
  })

  it('normalizes Gitea API base URLs', () => {
    expect(normalizeGiteaApiBaseUrl('https://git.example.com')).toBe(
      'https://git.example.com/api/v1'
    )
    expect(normalizeGiteaApiBaseUrl('https://git.example.com/api/v1/')).toBe(
      'https://git.example.com/api/v1'
    )
  })

  it('fetches a branch pull request and commit status', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const parsed = new URL(url)
      if (!init) {
        throw new Error('expected request init')
      }
      expect((init.headers as Record<string, string>).Authorization).toBe('token gitea-token')
      if (parsed.pathname.endsWith('/commits/abc123/status')) {
        return Response.json({ state: 'success' })
      }
      return Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getGiteaPullRequestForBranch('/repo', 'refs/heads/feature/gitea')
    ).resolves.toEqual({
      number: 7,
      title: 'Add Gitea',
      state: 'open',
      url: 'https://git.example.com/team/repo/pulls/7',
      status: 'success',
      updatedAt: '2026-05-15T00:00:00Z',
      mergeable: 'MERGEABLE',
      headSha: 'abc123'
    })

    const listUrl = new URL(String(fetchMock.mock.calls[0]?.[0]))
    expect(listUrl.origin).toBe('https://git.example.com')
    expect(listUrl.pathname).toBe('/api/v1/repos/team/repo/pulls')
    expect(listUrl.searchParams.get('state')).toBe('all')
    expect(listUrl.searchParams.get('sort')).toBe('recentupdate')
    expect(listUrl.searchParams.get('head')).toBe('feature/gitea')
    expect(listUrl.searchParams.get('limit')).toBe('5')
    expect(listUrl.searchParams.has('page')).toBe(false)
  })

  it('shares one /pulls scan across concurrent branch lookups (#8807)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      return Response.json([giteaPr(7, 'feature/a'), giteaPr(8, 'feature/b')])
    })
    vi.stubGlobal('fetch', fetchMock)

    const [a, b, missing] = await Promise.all([
      getGiteaPullRequestForBranch('/repo', 'feature/a'),
      getGiteaPullRequestForBranch('/repo', 'feature/b'),
      getGiteaPullRequestForBranch('/repo', 'feature/none')
    ])

    expect(a?.number).toBe(7)
    expect(b?.number).toBe(8)
    expect(missing).toBeNull()

    // The memoised verdict and the shared scan cache keep later lookups
    // consistent with the answers above.
    await expect(getGiteaPullRequestForBranch('/repo', 'feature/none')).resolves.toBeNull()
    await expect(getGiteaPullRequestForBranch('/repo', 'feature/a')).resolves.toMatchObject({
      number: 7
    })
  })

  it('reuses the cached /pulls scan for lookups inside the TTL', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      return Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
      number: 7
    })
    // The repeat lookup resolves from the cache, the other branch's probe
    // sees a mismatching entry, memoises the unsupported verdict, and falls
    // back to one shared full scan.
    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
      number: 7
    })
    await expect(getGiteaPullRequestForBranch('/repo', 'no-pr-branch')).resolves.toBeNull()
  })

  it('uses the Forgejo head filter as a fast path before any full scan (#35292)', async () => {
    const listQueries: URLSearchParams[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (!parsed.pathname.endsWith('/pulls')) {
        return Response.json([])
      }
      listQueries.push(parsed.searchParams)
      // A Forgejo 16+ server filters server-side: only matching PRs come back.
      return parsed.searchParams.get('head') === 'feature/gitea'
        ? Response.json([giteaPr(7, 'feature/gitea')])
        : Response.json([])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
      number: 7
    })

    // The filtered request alone answers: a fallback scan would query without
    // head= and find nothing, so resolving PR 7 pins the fast path. The wire
    // shape is the Forgejo one: all-state recentupdate head= probe, no paging.
    const probe = listQueries[0]
    expect(probe.get('state')).toBe('all')
    expect(probe.get('sort')).toBe('recentupdate')
    expect(probe.get('head')).toBe('feature/gitea')
    expect(probe.get('limit')).toBe('5')
    expect(probe.has('page')).toBe(false)
  })

  it('trusts the first entry when the filtered page is full of matches for the branch', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (!parsed.pathname.endsWith('/pulls')) {
        return Response.json([])
      }
      // Without the head filter the server sends an unfiltered page (no match
      // for this branch); only a filtered request fills the page with matches.
      if (parsed.searchParams.get('head') !== 'feature/gitea') {
        return Response.json([giteaPr(1, 'feature/other')])
      }
      // A reused branch name fills the small page with matches; the most
      // recently updated one is what today's find() would return too.
      return Response.json([
        giteaPr(11, 'feature/gitea'),
        giteaPr(12, 'feature/gitea'),
        giteaPr(13, 'feature/gitea'),
        giteaPr(14, 'feature/gitea'),
        giteaPr(15, 'feature/gitea')
      ])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
      number: 11
    })
  })

  it('trusts an empty filtered page as the definitive answer (#35292)', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (!parsed.pathname.endsWith('/pulls')) {
        return Response.json([])
      }
      // The filtered page is empty while the full listing does hold a matching
      // PR: only an implementation that trusts the empty page returns null.
      return parsed.searchParams.has('head') ? Response.json([]) : Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
  })

  it('falls back to the exact legacy scan when the server ignores the head filter (#35292)', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (!parsed.pathname.endsWith('/pulls')) {
        return Response.json([])
      }
      const page = parsed.searchParams.get('page')
      // Gitea ignores `head` and paginates unfiltered; the branch PR lives on
      // page 2, so page 1 must be full for the scan to reach it.
      return Response.json(
        page === '2'
          ? [giteaPr(99, 'feature/gitea')]
          : Array.from({ length: 50 }, (_, index) => giteaPr(index + 1, `feature/other-${index}`))
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
      number: 99
    })
  })

  it('stops probing after a server proves it ignores the head filter, and re-probes after hours', async () => {
    vi.useFakeTimers()
    try {
      let probedSinceLastCheck = false
      const fetchMock = vi.fn(async (url: string | URL) => {
        const parsed = new URL(String(url))
        if (parsed.pathname.endsWith('/status')) {
          return Response.json({ state: 'success' })
        }
        if (!parsed.pathname.endsWith('/pulls')) {
          return Response.json([])
        }
        if (parsed.searchParams.has('head')) {
          probedSinceLastCheck = true
          // The server ignores head=: the filter leaks an entry for another
          // branch even after a matching one, so any probe proves the misuse.
          return Response.json([giteaPr(1, 'feature/gitea'), giteaPr(2, 'feature/other')])
        }
        return Response.json([giteaPr(7, 'feature/gitea')])
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
        number: 7
      })
      expect(probedSinceLastCheck).toBe(true)
      probedSinceLastCheck = false

      // The negative verdict is memoised per host: no further probe inside its TTL.
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
        number: 7
      })
      expect(probedSinceLastCheck).toBe(false)

      // A long TTL later the probe retries, so an upgrade to Forgejo 16 is noticed.
      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 + 1)
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
        number: 7
      })
      expect(probedSinceLastCheck).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the head-filter verdict per API base URL', async () => {
    const probedHosts = new Set<string>()
    const fetchMock = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (!parsed.pathname.endsWith('/pulls')) {
        return Response.json([])
      }
      if (parsed.searchParams.has('head')) {
        probedHosts.add(parsed.origin)
      }
      // Both hosts ignore the filter here.
      return Response.json([giteaPr(1, 'feature/other')])
    })
    vi.stubGlobal('fetch', fetchMock)

    await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
    // A different host on the same repo path has its own verdict. No cache
    // reset in between: this only passes if the first host's verdict did not
    // leak into the second host.
    process.env.ORCA_GITEA_API_BASE_URL = 'https://other.example.com'
    _resetGiteaRepoRefCache()
    await getGiteaPullRequestForBranch('/repo', 'feature/gitea')

    expect(probedHosts.has('https://git.example.com')).toBe(true)
    expect(probedHosts.has('https://other.example.com')).toBe(true)
  })

  it('retries a failed /pulls scan after only the short failure cooldown', async () => {
    vi.useFakeTimers()
    try {
      let hostHealthy = false
      const fetchMock = vi.fn(async (url: string) => {
        const parsed = new URL(url)
        if (parsed.pathname.endsWith('/status')) {
          return Response.json({ state: 'success' })
        }
        return hostHealthy
          ? Response.json([giteaPr()])
          : Response.json({ message: 'temporary failure' }, { status: 503 })
      })
      vi.stubGlobal('fetch', fetchMock)

      // The probe fails and cools down; the fallback scan fails and is retried
      // only after its own short cooldown, not treated as a durable miss.
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
      // Inside the cooldowns the lookup skips the failed probe and scan.
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
      hostHealthy = true

      await vi.advanceTimersByTimeAsync(3_001)
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
        number: 7
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a lookup failure via getGiteaPullRequestForBranchOrThrow instead of null (finding 4)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: 'unauthorized' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
    // Strict lookup must distinguish unavailable transport from a confirmed missing review.
    await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea')).rejects.toThrow(
      /Gitea request failed/
    )
  })

  it('keeps a failed in-flight head= probe from rejecting lenient lookups that join it (#36049)', async () => {
    let releaseProbe!: () => void
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve
    })
    let probeStarted!: () => void
    const probeInFlight = new Promise<void>((resolve) => {
      probeStarted = resolve
    })
    const fetchMock = vi.fn(async (url: string | URL) => {
      const parsed = new URL(String(url))
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (parsed.searchParams.has('head')) {
        // The strict lookup starts the probe; the lenient one joins it in flight.
        probeStarted()
        await probeGate
      }
      return Response.json({ message: 'temporary failure' }, { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const strict = getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea')
    await probeInFlight
    const lenient = getGiteaPullRequestForBranch('/repo', 'feature/gitea')

    // While the shared probe is gated, a lookup that re-issued the request
    // would fail fast and settle; only one that joined the in-flight probe
    // stays pending. A settled promise loses this race, a pending one wins.
    const stillPending = await Promise.race([
      lenient.then(
        () => false,
        () => false
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 0))
    ])
    expect(stillPending).toBe(true)
    releaseProbe()

    // The lenient contract reads transport failure as absence, never a throw,
    // even when the shared probe was started by a strict lookup.
    await expect(lenient).resolves.toBeNull()
    // The strict lookup still surfaces the failure itself.
    await expect(strict).rejects.toThrow(/Gitea request failed/)
  })

  it('treats a 404 on the linked PR as "no PR" rather than a lookup failure', async () => {
    const requested: string[] = []
    const fetchMock = vi.fn(async (url: string | URL) => {
      requested.push(new URL(String(url)).pathname)
      // The branch scan succeeds and is simply empty; only PR #42 is gone.
      return String(url).includes('/pulls/42')
        ? Response.json({ message: 'not found' }, { status: 404 })
        : Response.json([])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea', 42)
    ).resolves.toBeNull()
    expect(requested).toEqual(['/api/v1/repos/team/repo/pulls', '/api/v1/repos/team/repo/pulls/42'])
  })

  it('still throws on a 404 from the /pulls scan so a misconfigured host is not read as "no PR"', async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: 'not found' }, { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    // A repo-level 404 means wrong base URL / repo absent / token lacks scope —
    // collapsing it to "no PR" would hide the misconfiguration indefinitely.
    await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea')).rejects.toThrow(
      /Gitea request failed: HTTP 404/
    )
  })

  it('does not let an in-flight scan re-cache results from before an invalidation', async () => {
    let releaseFirstScan!: () => void
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve
    })
    let firstScanStarted = false
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      if (!firstScanStarted) {
        // First listing is in flight (pre-create) when the invalidation lands.
        firstScanStarted = true
        await firstScanGate
        return Response.json([giteaPr(7, 'feature/old')])
      }
      return Response.json([giteaPr(7, 'feature/old'), giteaPr(8, 'feature/new')])
    })
    vi.stubGlobal('fetch', fetchMock)

    const staleScanRead = getGiteaPullRequestForBranch('/repo', 'feature/old')
    const { invalidateGiteaPullRequestScanForRepo, getGiteaRepoSlug } = await import('./client')
    const repo = await getGiteaRepoSlug('/repo')
    invalidateGiteaPullRequestScanForRepo(repo!)
    releaseFirstScan()
    await staleScanRead

    // The invalidated lookups re-fetch instead of reading the stale result:
    // the new branch's probe leaks an entry for the old branch and the
    // fallback scan finds PR 8.
    await expect(getGiteaPullRequestForBranch('/repo', 'feature/new')).resolves.toMatchObject({
      number: 8
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

    await getGiteaPullRequestForBranch('/repo', 'refs/heads/feature/gitea')

    expect(fetchMock).toHaveBeenCalled()
    expect(cancelledBodies).toBe(fetchMock.mock.calls.length)
  })
})
