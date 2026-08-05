import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { acquireMock, ghExecFileAsyncMock, releaseMock } = vi.hoisted(() => ({
  acquireMock: vi.fn(() => Promise.resolve()),
  ghExecFileAsyncMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  acquire: acquireMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  release: releaseMock
}))

import {
  _getAuthenticatedViewerCacheSize,
  _resetAuthenticatedViewerCache,
  getAuthenticatedViewer
} from './authenticated-viewer'

describe('getAuthenticatedViewer', () => {
  beforeEach(() => {
    _resetAuthenticatedViewerCache()
    acquireMock.mockClear()
    ghExecFileAsyncMock.mockReset()
    releaseMock.mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('deduplicates concurrent and cached lookups in one auth scope', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ login: 'octocat', email: 'octocat@example.com' }),
      stderr: ''
    })
    const options = { cwd: '/workspace/one', host: 'github.com' }

    await expect(
      Promise.all([
        getAuthenticatedViewer(options),
        getAuthenticatedViewer({ ...options, cwd: '/workspace/two' })
      ])
    ).resolves.toEqual([
      { login: 'octocat', email: 'octocat@example.com' },
      { login: 'octocat', email: 'octocat@example.com' }
    ])
    await expect(getAuthenticatedViewer(options)).resolves.toEqual({
      login: 'octocat',
      email: 'octocat@example.com'
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(acquireMock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('isolates GitHub hosts and WSL auth scopes', async () => {
    ghExecFileAsyncMock.mockImplementation(async (_args, options) => ({
      stdout: JSON.stringify({ login: `${options.host}:${options.wslDistro ?? 'native'}` }),
      stderr: ''
    }))

    await Promise.all([
      getAuthenticatedViewer({ host: 'github.com' }),
      getAuthenticatedViewer({ host: 'ghe.example.com' }),
      getAuthenticatedViewer({ host: 'github.com', wslDistro: 'Ubuntu' })
    ])

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('aliases the ambient default host to its explicit hostname', async () => {
    vi.stubEnv('GH_HOST', '')
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ login: 'octocat' }),
      stderr: ''
    })

    await Promise.all([getAuthenticatedViewer(), getAuthenticatedViewer({ host: 'github.com' })])

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('expires successful identity lookups after thirty seconds', async () => {
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ login: 'octocat' }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ login: 'hubot' }), stderr: '' })

    await expect(getAuthenticatedViewer({ host: 'github.com' })).resolves.toMatchObject({
      login: 'octocat'
    })
    now += 30_001
    await expect(getAuthenticatedViewer({ host: 'github.com' })).resolves.toMatchObject({
      login: 'hubot'
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('bypasses a cached identity on an explicit refresh', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify({ login: 'octocat' }), stderr: '' })
      .mockResolvedValueOnce({ stdout: JSON.stringify({ login: 'hubot' }), stderr: '' })

    await expect(getAuthenticatedViewer({ host: 'github.com' })).resolves.toMatchObject({
      login: 'octocat'
    })
    await expect(
      getAuthenticatedViewer({ host: 'github.com', force: true })
    ).resolves.toMatchObject({ login: 'hubot' })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('returns and briefly caches null when the CLI lookup fails', async () => {
    ghExecFileAsyncMock.mockRejectedValue(new Error('not authenticated'))

    await expect(getAuthenticatedViewer({ host: 'github.com' })).resolves.toBeNull()
    await expect(getAuthenticatedViewer({ host: 'github.com' })).resolves.toBeNull()

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('bounds cached auth scopes', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify({ login: 'octocat' }),
      stderr: ''
    })

    for (let index = 0; index < 40; index += 1) {
      await getAuthenticatedViewer({ host: `ghe-${index}.example.com` })
    }

    expect(_getAuthenticatedViewerCacheSize()).toBeLessThanOrEqual(32)
  })
})
