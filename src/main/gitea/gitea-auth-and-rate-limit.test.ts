import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { teaExecFileAsyncMock } = vi.hoisted(() => ({ teaExecFileAsyncMock: vi.fn() }))

vi.mock('../git/runner', () => ({ teaExecFileAsync: teaExecFileAsyncMock }))

const { teaApiWithHeadersMock } = vi.hoisted(() => ({ teaApiWithHeadersMock: vi.fn() }))

vi.mock('./tea-api-response', () => ({
  teaApiWithHeaders: teaApiWithHeadersMock
}))

import {
  _getGiteaRateLimitCacheSize,
  _resetGiteaRateLimitCache,
  diagnoseGiteaAuth,
  getAuthenticatedViewer,
  getRateLimit
} from './gitea-auth-and-rate-limit'
import { _resetTeaKnownHostsCache, getTeaKnownHosts } from './gitea-known-host-probe'

const STATUS = JSON.stringify([
  {
    name: 'codeberg',
    url: 'https://codeberg.org',
    user: 'alice',
    valid: true,
    default: true
  }
])

describe('diagnoseGiteaAuth', () => {
  const previousEnv = { ...process.env }

  beforeEach(() => {
    teaExecFileAsyncMock.mockReset()
    teaApiWithHeadersMock.mockReset()
    _resetTeaKnownHostsCache()
    _resetGiteaRateLimitCache()
    process.env = { ...previousEnv }
    delete process.env.ORCA_GITEA_TOKEN
    delete process.env.GITEA_TOKEN
    delete process.env.ORCA_GITEA_API_BASE_URL
    delete process.env.GITEA_INSTANCE_URL
  })

  afterEach(() => {
    process.env = previousEnv
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reports valid logins from tea login status json', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce({ stdout: STATUS, stderr: '' })

    await expect(diagnoseGiteaAuth()).resolves.toMatchObject({
      teaAvailable: true,
      authenticated: true,
      hosts: ['codeberg.org'],
      activeHost: 'codeberg.org',
      envTokenInProcess: null,
      error: null
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(['login', 'status', '-o', 'json'], {
      allowDefaultWslFallback: false
    })
    await expect(getTeaKnownHosts()).resolves.toEqual(['codeberg.org'])
    expect(teaExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('falls back to ORCA_GITEA_TOKEN when tea has no valid login', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]', stderr: '' })
    process.env.ORCA_GITEA_TOKEN = 'orca-token'
    process.env.ORCA_GITEA_API_BASE_URL = 'https://git.example.com/git'

    await expect(diagnoseGiteaAuth()).resolves.toMatchObject({
      teaAvailable: true,
      authenticated: true,
      envTokenInProcess: 'ORCA_GITEA_TOKEN',
      hosts: ['git.example.com/git'],
      activeHost: 'git.example.com/git'
    })
  })

  it('reports GITEA_TOKEN when the Orca token is unset', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]', stderr: '' })
    process.env.GITEA_TOKEN = 'tea-token'
    process.env.GITEA_INSTANCE_URL = 'https://codeberg.org'

    await expect(diagnoseGiteaAuth()).resolves.toMatchObject({
      authenticated: true,
      envTokenInProcess: 'GITEA_TOKEN',
      hosts: ['codeberg.org']
    })
  })

  it('reports a missing tea binary as unavailable', async () => {
    teaExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('spawn tea ENOENT'), { code: 'ENOENT' })
    )

    await expect(diagnoseGiteaAuth()).resolves.toMatchObject({
      teaAvailable: false,
      authenticated: false,
      hosts: [],
      activeHost: null,
      error: expect.stringMatching(/ENOENT/)
    })
  })
})

describe('getAuthenticatedViewer', () => {
  const previousEnv = { ...process.env }

  beforeEach(() => {
    teaExecFileAsyncMock.mockReset()
    process.env = { ...previousEnv }
    delete process.env.ORCA_GITEA_TOKEN
    delete process.env.GITEA_TOKEN
    delete process.env.ORCA_GITEA_API_BASE_URL
    delete process.env.GITEA_INSTANCE_URL
  })

  afterEach(() => {
    process.env = previousEnv
    vi.unstubAllGlobals()
  })

  it('reads the authenticated login from tea api /user', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ login: 'alice', email: 'alice@example.com' }),
      stderr: ''
    })

    await expect(getAuthenticatedViewer()).resolves.toEqual({
      username: 'alice',
      email: 'alice@example.com'
    })
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(['api', '/user'], {})
  })

  it('selects a login name with --login and a host with GITEA_INSTANCE_URL', async () => {
    teaExecFileAsyncMock.mockResolvedValue({ stdout: '{"login":"alice","email":null}', stderr: '' })

    await getAuthenticatedViewer('codeberg')
    expect(teaExecFileAsyncMock).toHaveBeenCalledWith(['api', '--login', 'codeberg', '/user'], {})

    await getAuthenticatedViewer('git.example.com')
    expect(teaExecFileAsyncMock).toHaveBeenLastCalledWith(
      ['api', '/user'],
      expect.objectContaining({
        env: expect.objectContaining({ GITEA_INSTANCE_URL: 'https://git.example.com' })
      })
    )
  })

  it('falls back to the Gitea HTTP API when tea fails and an Orca token is set', async () => {
    teaExecFileAsyncMock.mockRejectedValueOnce(new Error('tea missing'))
    process.env.ORCA_GITEA_TOKEN = 'tok'
    process.env.ORCA_GITEA_API_BASE_URL = 'https://git.example.com'
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ login: 'alice', email: '' })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(getAuthenticatedViewer()).resolves.toEqual({ username: 'alice', email: null })
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://git.example.com/api/v1/user')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'token tok' }
    })
  })

  it('returns null when the payload has no login', async () => {
    teaExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}', stderr: '' })
    await expect(getAuthenticatedViewer()).resolves.toBeNull()
  })
})

describe('getRateLimit', () => {
  beforeEach(() => {
    teaApiWithHeadersMock.mockReset()
    _resetGiteaRateLimitCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('parses Gitea rate-limit headers from tea api -i /user', async () => {
    teaApiWithHeadersMock.mockResolvedValueOnce({
      status: 200,
      body: '{}',
      headers: {
        'x-ratelimit-limit': '60',
        'x-ratelimit-remaining': '59',
        'x-ratelimit-reset': '1780000000'
      }
    })

    await expect(getRateLimit({ host: 'codeberg.org', force: true })).resolves.toMatchObject({
      ok: true,
      snapshot: {
        host: 'codeberg.org',
        rest: { limit: 60, remaining: 59, resetAt: 1780000000 }
      }
    })
    expect(teaApiWithHeadersMock).toHaveBeenCalledWith(
      ['/user'],
      expect.objectContaining({
        env: expect.objectContaining({ GITEA_INSTANCE_URL: 'https://codeberg.org' })
      })
    )
  })

  it('reports a null bucket when the host omits rate-limit headers', async () => {
    teaApiWithHeadersMock.mockResolvedValueOnce({ status: 200, body: '{}', headers: {} })

    await expect(getRateLimit({ force: true })).resolves.toMatchObject({
      ok: true,
      snapshot: { host: null, rest: null }
    })
    expect(teaApiWithHeadersMock).toHaveBeenCalledWith(['/user'], {})
  })

  it('reuses a snapshot for 30 seconds per host and bounds the cache', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    teaApiWithHeadersMock.mockResolvedValue({ status: 200, body: '{}', headers: {} })

    await getRateLimit({ host: 'codeberg.org' })
    await getRateLimit({ host: 'codeberg.org' })
    expect(teaApiWithHeadersMock).toHaveBeenCalledTimes(1)

    vi.mocked(Date.now).mockReturnValue(1_000 + 30_000)
    await getRateLimit({ host: 'codeberg.org' })
    expect(teaApiWithHeadersMock).toHaveBeenCalledTimes(2)

    for (let index = 0; index < 70; index++) {
      await getRateLimit({ host: `git-${index}.example.com`, force: true })
    }
    expect(_getGiteaRateLimitCacheSize()).toBe(64)
  })
})
