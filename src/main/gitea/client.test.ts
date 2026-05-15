import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  getGiteaAuthStatus,
  getGiteaPullRequestForBranch,
  normalizeGiteaApiBaseUrl
} from './client'
import { _resetGiteaRepoRefCache } from './repository-ref'

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
})
