import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetAzCliTokenCache, getAzureDevOpsAzCliAccessToken } from './az-cli-token'

const { execLocalPreflightCommandMock, isCommandAvailableMock } = vi.hoisted(() => ({
  execLocalPreflightCommandMock: vi.fn(),
  isCommandAvailableMock: vi.fn()
}))

vi.mock('../ipc/preflight-command-exec', () => ({
  execLocalPreflightCommand: execLocalPreflightCommandMock,
  isCommandAvailable: isCommandAvailableMock
}))

function tokenJson(accessToken = 'az-token', expiresOnSeconds?: number): string {
  return JSON.stringify({
    accessToken,
    ...(expiresOnSeconds === undefined ? {} : { expires_on: expiresOnSeconds })
  })
}

describe('Azure DevOps az CLI token', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-29T12:00:00Z'))
    execLocalPreflightCommandMock.mockReset()
    isCommandAvailableMock.mockReset()
    _resetAzCliTokenCache()
  })

  afterEach(() => {
    _resetAzCliTokenCache()
    vi.useRealTimers()
  })

  it('returns and caches a valid token with an epoch-seconds expiry', async () => {
    const expiresOnSeconds = Math.floor(Date.now() / 1000) + 3600
    execLocalPreflightCommandMock.mockResolvedValue({
      stdout: tokenJson('az-token', expiresOnSeconds),
      stderr: ''
    })

    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toEqual({
      token: 'az-token',
      expiresAtMs: expiresOnSeconds * 1000
    })
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toEqual({
      token: 'az-token',
      expiresAtMs: expiresOnSeconds * 1000
    })
    expect(execLocalPreflightCommandMock).toHaveBeenCalledOnce()
    expect(execLocalPreflightCommandMock).toHaveBeenCalledWith('az', [
      'account',
      'get-access-token',
      '--resource',
      '499b84ac-1321-427f-aa17-267ca6975798',
      '--output',
      'json'
    ])
  })

  it('uses a fixed five-minute cache when expires_on is missing', async () => {
    execLocalPreflightCommandMock
      .mockResolvedValueOnce({ stdout: tokenJson('first-token'), stderr: '' })
      .mockResolvedValueOnce({ stdout: tokenJson('second-token'), stderr: '' })

    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toEqual({
      token: 'first-token',
      expiresAtMs: null
    })
    vi.setSystemTime(new Date(Date.now() + 299_000))
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toMatchObject({
      token: 'first-token'
    })
    vi.setSystemTime(new Date(Date.now() + 2_000))
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toMatchObject({
      token: 'second-token'
    })
    expect(execLocalPreflightCommandMock).toHaveBeenCalledTimes(2)
  })

  it('returns null when az exits non-zero', async () => {
    execLocalPreflightCommandMock.mockRejectedValue(new Error('not logged in'))

    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toBeNull()
  })

  it('returns null when az is missing', async () => {
    execLocalPreflightCommandMock.mockRejectedValue(
      Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' })
    )

    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toBeNull()
  })

  it('caches a failure briefly so a status poll does not re-spawn az for every call', async () => {
    execLocalPreflightCommandMock.mockRejectedValue(new Error('not logged in'))

    // Why: one PR-status poll makes several sequential REST calls — without a
    // negative cache, each would re-spawn `az` when it is installed-but-logged-out.
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toBeNull()
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toBeNull()
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toBeNull()
    expect(execLocalPreflightCommandMock).toHaveBeenCalledOnce()

    // Re-spawns once the 30s negative window elapses.
    vi.setSystemTime(new Date(Date.now() + 31_000))
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toBeNull()
    expect(execLocalPreflightCommandMock).toHaveBeenCalledTimes(2)
  })

  it('returns null for malformed JSON', async () => {
    execLocalPreflightCommandMock.mockResolvedValue({ stdout: '{', stderr: '' })

    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toBeNull()
  })

  it('returns null for an empty access token', async () => {
    execLocalPreflightCommandMock.mockResolvedValue({
      stdout: tokenJson('   ', Math.floor(Date.now() / 1000) + 3600),
      stderr: ''
    })

    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toBeNull()
  })

  it('refreshes the cache after the safety-window TTL expires', async () => {
    const nowSeconds = Math.floor(Date.now() / 1000)
    execLocalPreflightCommandMock
      .mockResolvedValueOnce({ stdout: tokenJson('first-token', nowSeconds + 120), stderr: '' })
      .mockResolvedValueOnce({ stdout: tokenJson('second-token', nowSeconds + 3600), stderr: '' })

    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toMatchObject({
      token: 'first-token'
    })
    vi.setSystemTime(new Date(Date.now() + 59_000))
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toMatchObject({
      token: 'first-token'
    })
    vi.setSystemTime(new Date(Date.now() + 2_000))
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toMatchObject({
      token: 'second-token'
    })
    expect(execLocalPreflightCommandMock).toHaveBeenCalledTimes(2)
  })

  it('shares one spawn for concurrent callers', async () => {
    let resolveCommand = (_value: { stdout: string; stderr: string }): void => {}
    const commandResult = new Promise<{ stdout: string; stderr: string }>((resolve) => {
      resolveCommand = resolve
    })
    execLocalPreflightCommandMock.mockReturnValue(commandResult)

    const first = getAzureDevOpsAzCliAccessToken()
    const second = getAzureDevOpsAzCliAccessToken()

    expect(execLocalPreflightCommandMock).toHaveBeenCalledOnce()
    resolveCommand({
      stdout: tokenJson('az-token', Math.floor(Date.now() / 1000) + 3600),
      stderr: ''
    })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { token: 'az-token', expiresAtMs: (Math.floor(Date.now() / 1000) + 3600) * 1000 },
      { token: 'az-token', expiresAtMs: (Math.floor(Date.now() / 1000) + 3600) * 1000 }
    ])
  })

  it('clears cached tokens when reset', async () => {
    execLocalPreflightCommandMock
      .mockResolvedValueOnce({
        stdout: tokenJson('first-token', Math.floor(Date.now() / 1000) + 3600),
        stderr: ''
      })
      .mockResolvedValueOnce({
        stdout: tokenJson('second-token', Math.floor(Date.now() / 1000) + 3600),
        stderr: ''
      })

    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toMatchObject({
      token: 'first-token'
    })
    _resetAzCliTokenCache()
    await expect(getAzureDevOpsAzCliAccessToken()).resolves.toMatchObject({
      token: 'second-token'
    })
    expect(execLocalPreflightCommandMock).toHaveBeenCalledTimes(2)
  })
})
