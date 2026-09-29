import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateGiteaApiUrl } from './api-url'
import { giteaGetJsonAtBase, giteaRepoGetText, giteaRepoWrite, resolveGiteaAuth } from './request'
import { parseGiteaRepoRef } from './repository-ref'

const { serverForHost } = vi.hoisted(() => ({ serverForHost: vi.fn() }))
vi.mock('./server-store', () => ({
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
    'http://git.example.com',
    'ftp://localhost',
    'https://user:pass@git.example.com',
    'https://git.example.com?token=value',
    'https://git.example.com#fragment'
  ])('rejects %s', (url) => {
    expect(() => validateGiteaApiUrl(url)).toThrow()
  })

  it.each([
    'https://git.example.com:8443/gitea',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://[::1]:3000'
  ])('accepts %s', (url) => {
    expect(validateGiteaApiUrl(url)).toBe(url)
  })

  it('never sends credentials on plaintext JSON, file, or mutation requests', async () => {
    vi.stubEnv('ORCA_GITEA_TOKEN', 'test-token')
    vi.stubEnv('ORCA_GITEA_API_BASE_URL', '')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const repo = parseGiteaRepoRef('http://git.example.com/team/project.git')
    if (!repo) {
      throw new Error('Missing test repository')
    }
    await expect(
      giteaGetJsonAtBase(repo.apiBaseUrl, '/user', { token: 'test-token' })
    ).resolves.toBeNull()
    await expect(giteaRepoGetText(repo, '/file')).resolves.toBeNull()
    await expect(giteaRepoWrite(repo, '/issues', { method: 'POST' })).resolves.toMatchObject({
      ok: false
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('matches a saved token to a non-default HTTPS port', () => {
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
    expect(resolveGiteaAuth(repo)).toEqual({ apiBaseUrl, token: 'saved-token' })
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
