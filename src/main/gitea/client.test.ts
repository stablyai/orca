import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelTrackingResponse } from '../lib/unread-response-body.test-fixtures'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  getGiteaAuthStatus,
  getGiteaPullRequestForBranch,
  getGiteaPullRequestForBranchOrThrow,
  normalizeGiteaApiBaseUrl
} from './client'
import { _resetGiteaRepoRefCache } from './repository-ref'
import {
  _getGiteaPullRequestScanCacheSize,
  _resetGiteaPullRequestScanCache,
  scanGiteaPullRequests
} from './pull-request-scan-cache'

const OLD_ENV = process.env

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
    vi.unstubAllGlobals()
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
    expect(listUrl.searchParams.get('page')).toBe('1')
    expect(listUrl.searchParams.get('limit')).toBe('50')
  })

  it('shares one /pulls scan across concurrent branch lookups (#8807)', async () => {
    let listCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      listCalls++
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
    expect(listCalls).toBe(1)
  })

  it('reuses the cached /pulls scan for lookups inside the TTL', async () => {
    let listCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      listCalls++
      return Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
    await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
    await getGiteaPullRequestForBranch('/repo', 'no-pr-branch')

    expect(listCalls).toBe(1)
  })

  it('retries a failed /pulls scan after only the short failure cooldown', async () => {
    vi.useFakeTimers()
    try {
      let listCalls = 0
      const fetchMock = vi.fn(async (url: string) => {
        const parsed = new URL(url)
        if (parsed.pathname.endsWith('/status')) {
          return Response.json({ state: 'success' })
        }
        listCalls++
        return listCalls === 1
          ? Response.json({ message: 'temporary failure' }, { status: 503 })
          : Response.json([giteaPr()])
      })
      vi.stubGlobal('fetch', fetchMock)

      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
      expect(listCalls).toBe(1)

      await vi.advanceTimersByTimeAsync(3_001)
      await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
        number: 7
      })
      expect(listCalls).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('surfaces a lookup failure via getGiteaPullRequestForBranchOrThrow instead of null (finding 4)', async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: 'unauthorized' }, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)

    // The swallowing variant returns null — indistinguishable from "no PR".
    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toBeNull()
    // The throwing variant makes the failure visible so eligibility records
    // `unavailable` rather than a false "No pull request found".
    await expect(getGiteaPullRequestForBranchOrThrow('/repo', 'feature/gitea')).rejects.toThrow(
      /Gitea request failed/
    )
  })

  it('expires successful scans and bounds retained repository listings', async () => {
    vi.useFakeTimers()
    try {
      let listCalls = 0
      const fetchMock = vi.fn(async (url: string) => {
        const parsed = new URL(url)
        if (parsed.pathname.endsWith('/status')) {
          return Response.json({ state: 'success' })
        }
        listCalls++
        return Response.json([giteaPr()])
      })
      vi.stubGlobal('fetch', fetchMock)

      await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
      expect(_getGiteaPullRequestScanCacheSize()).toBe(1)
      await vi.advanceTimersByTimeAsync(30_001)
      expect(_getGiteaPullRequestScanCacheSize()).toBe(0)
      await getGiteaPullRequestForBranch('/repo', 'feature/gitea')
      expect(listCalls).toBe(2)

      await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          scanGiteaPullRequests(`repo-${index}`, async () => [], 50, 5)
        )
      )
      expect(_getGiteaPullRequestScanCacheSize()).toBe(32)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let an in-flight scan re-cache results from before an invalidation', async () => {
    let releaseFirstScan!: () => void
    const firstScanGate = new Promise<void>((resolve) => {
      releaseFirstScan = resolve
    })
    let listCalls = 0
    const fetchMock = vi.fn(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname.endsWith('/status')) {
        return Response.json({ state: 'success' })
      }
      listCalls++
      if (listCalls === 1) {
        // First scan is in flight (pre-create listing) when the invalidation lands.
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

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/new')).resolves.toMatchObject({
      number: 8
    })
    expect(listCalls).toBe(2)
  })

  it('uses an API base URL override for subpath or non-standard deployments', async () => {
    process.env.ORCA_GITEA_API_BASE_URL = 'https://git.example.com/code'
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes('/commits/abc123/status')) {
        return Response.json({ state: 'pending' })
      }
      return Response.json([giteaPr()])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'feature/gitea')).resolves.toMatchObject({
      number: 7,
      status: 'pending'
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      'https://git.example.com/code/api/v1/repos/team/repo/pulls'
    )
  })

  it('falls back to a linked PR number when branch lookup misses', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const requestUrl = String(url)
      if (requestUrl.includes('/commits/abc123/status')) {
        return Response.json({ state: 'success' })
      }
      if (requestUrl.endsWith('/pulls/42')) {
        return Response.json(giteaPr(42, 'renamed-local-branch'))
      }
      return Response.json([])
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaPullRequestForBranch('/repo', 'local-name', 42)).resolves.toMatchObject({
      number: 42,
      status: 'success'
    })
  })

  it('reports configured token auth without a global API base URL', async () => {
    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: null,
      baseUrl: null,
      tokenConfigured: true
    })
  })

  it('verifies token auth when a global API base URL is configured', async () => {
    process.env.ORCA_GITEA_API_BASE_URL = 'https://git.example.com'
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ login: 'gitea-user' })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(getGiteaAuthStatus()).resolves.toEqual({
      configured: true,
      authenticated: true,
      account: 'gitea-user',
      baseUrl: 'https://git.example.com/api/v1',
      tokenConfigured: true
    })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://git.example.com/api/v1/user')
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
