import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateGiteaApiUrl } from './gitea-api-url'
import { giteaGetJsonAtBase, resolveGiteaAuth } from './gitea-request'
import { parseGiteaRepoRef } from '../repository-ref'

const { serverForHost } = vi.hoisted(() => ({ serverForHost: vi.fn() }))
vi.mock('../servers/gitea-server-store', () => ({
  getServerForHost: serverForHost,
  normalizeGiteaApiBaseUrl: (value: string) => value
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('Gitea credential destinations', () => {
  it.each([
    'ftp://localhost',
    'https://user:pass@git.example.com',
    'https://git.example.com?token=value',
    'https://git.example.com#fragment'
  ])('rejects %s', (url) => {
    expect(() => validateGiteaApiUrl(url)).toThrow()
  })

  it.each([
    'https://git.example.com:8443/gitea',
    'http://gitea:3000',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000'
  ])('accepts %s', (url) => {
    expect(validateGiteaApiUrl(url)).toBe(url)
  })

  it('never sends a saved token to a different host', async () => {
    vi.stubEnv('ORCA_GITEA_TOKEN', '')
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', '')
    serverForHost.mockImplementation((host: string) =>
      host === 'git.example.com'
        ? { server: { apiBaseUrl: 'https://git.example.com/api/v1' }, token: 'saved-token' }
        : null
    )
    const repo = parseGiteaRepoRef('https://git.example.com.evil.test/team/project.git')
    if (!repo) {
      throw new Error('Missing test repository')
    }
    await expect(resolveGiteaAuth(repo)).resolves.toMatchObject({ token: null })
  })

  it('scopes an environment token to ORCA_GITEA_API_BASE_URL when it is set', async () => {
    vi.stubEnv('ORCA_GITEA_TOKEN', 'env-token')
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'https://git.example.com')
    serverForHost.mockResolvedValue(null)
    const repo = parseGiteaRepoRef('https://other.example.com/team/project.git')
    if (!repo) {
      throw new Error('Missing test repository')
    }
    await expect(resolveGiteaAuth(repo)).resolves.toMatchObject({ token: null })
  })

  it('sends the environment token to its API on another port for an SSH remote of that host', async () => {
    vi.stubEnv('ORCA_GITEA_TOKEN', 'env-token')
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', 'http://git.lan:3000')
    serverForHost.mockResolvedValue(null)
    const sameHost = parseGiteaRepoRef('git@git.lan:team/project.git')
    const otherHost = parseGiteaRepoRef('git@git.other:team/project.git')
    if (!sameHost || !otherHost) {
      throw new Error('Missing test repository')
    }
    await expect(resolveGiteaAuth(sameHost)).resolves.toEqual({
      apiBaseUrl: 'http://git.lan:3000',
      token: 'env-token'
    })
    await expect(resolveGiteaAuth(otherHost)).resolves.toMatchObject({ token: null })
  })

  it('matches a saved token to a non-default HTTPS port', async () => {
    vi.stubEnv('ORCA_GITEA_TOKEN', '')
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', '')
    const apiBaseUrl = 'https://git.example.com:8443/api/v1'
    serverForHost.mockImplementation((host: string) =>
      host === 'git.example.com:8443' ? { server: { apiBaseUrl }, token: 'saved-token' } : null
    )
    const repo = parseGiteaRepoRef('https://git.example.com:8443/team/project.git')
    if (!repo) {
      throw new Error('Missing test repository')
    }
    await expect(resolveGiteaAuth(repo)).resolves.toEqual({ apiBaseUrl, token: 'saved-token' })
  })

  it('refuses redirects when sending a token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ login: 'tester' }))
    vi.stubGlobal('fetch', fetchMock)
    await giteaGetJsonAtBase('https://git.example.com/api/v1', '/user', { token: 'test-token' })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'error' })
    )
  })

  it('surfaces permission failures for task reads while preserving optional lookups', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => new Response('', { status: 403 }))
    )
    await expect(
      giteaGetJsonAtBase('https://git.example.com/api/v1', '/user', {}, true)
    ).rejects.toThrow('HTTP 403')
    await expect(giteaGetJsonAtBase('https://git.example.com/api/v1', '/user')).resolves.toBeNull()
  })
})
