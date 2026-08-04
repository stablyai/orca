import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  extractCredentialsMock,
  readAuthJsonMock,
  readGeminiCredentialsMock,
  saveAuthJsonSourceMock,
  saveGeminiCredentialsMock
} = vi.hoisted(() => ({
  extractCredentialsMock: vi.fn(),
  readAuthJsonMock: vi.fn(),
  readGeminiCredentialsMock: vi.fn(),
  saveAuthJsonSourceMock: vi.fn(),
  saveGeminiCredentialsMock: vi.fn()
}))

vi.mock('./gemini-cli-oauth-extractor', () => ({
  extractOAuthClientCredentials: extractCredentialsMock
}))

vi.mock('./gemini-oauth-sources', () => ({
  readAuthJsonSource: readAuthJsonMock,
  readGeminiCredentials: readGeminiCredentialsMock,
  saveAuthJsonSource: saveAuthJsonSourceMock,
  saveGeminiCredentials: saveGeminiCredentialsMock
}))

import {
  getGeminiOAuthPreparationSnapshot,
  hydrateGeminiOAuthPreparationSnapshot,
  commitGeminiOAuthTokenRefresh,
  resetGeminiOAuthPreparationSnapshotForTests
} from './gemini-oauth-preparation-snapshot'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function authJsonSource(access: string, expires: number, refresh: string) {
  return {
    path: '/home/alice/.local/share/opencode/auth.json',
    value: { google: { type: 'oauth' as const, access, expires, refresh } }
  }
}

describe('Gemini OAuth preparation snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetGeminiOAuthPreparationSnapshotForTests()
    extractCredentialsMock.mockResolvedValue({ clientId: 'client', clientSecret: 'secret' })
    readGeminiCredentialsMock.mockResolvedValue(null)
    saveAuthJsonSourceMock.mockImplementation(async (source) => {
      readAuthJsonMock.mockResolvedValue(source)
    })
    saveGeminiCredentialsMock.mockImplementation(async (credentials) => {
      readGeminiCredentialsMock.mockResolvedValue(credentials)
    })
  })

  it('coalesces concurrent hydration into one credential and discovery read', async () => {
    const read = deferred<ReturnType<typeof authJsonSource>>()
    readAuthJsonMock.mockReturnValue(read.promise)

    const first = hydrateGeminiOAuthPreparationSnapshot(true)
    const second = hydrateGeminiOAuthPreparationSnapshot(true)
    read.resolve(authJsonSource('token', 10, 'refresh'))

    await Promise.all([first, second])
    expect(readAuthJsonMock).toHaveBeenCalledTimes(1)
    expect(extractCredentialsMock).toHaveBeenCalledTimes(1)
    expect(getGeminiOAuthPreparationSnapshot()).toMatchObject({
      stale: false,
      availability: 'ready',
      value: { source: 'auth-json' }
    })
  })

  it('rejects late hydration publication after opt-out revokes ownership', async () => {
    const read = deferred<ReturnType<typeof authJsonSource>>()
    readAuthJsonMock.mockReturnValue(read.promise)

    const hydration = hydrateGeminiOAuthPreparationSnapshot(true)
    await hydrateGeminiOAuthPreparationSnapshot(false)
    read.resolve(authJsonSource('late', 10, 'refresh'))
    await hydration

    expect(getGeminiOAuthPreparationSnapshot()).toMatchObject({
      value: null,
      stale: false,
      availability: 'missing'
    })
  })

  it('does not touch OAuth sources or CLI discovery while opt-in is disabled', async () => {
    await hydrateGeminiOAuthPreparationSnapshot(false)

    expect(readAuthJsonMock).not.toHaveBeenCalled()
    expect(readGeminiCredentialsMock).not.toHaveBeenCalled()
    expect(extractCredentialsMock).not.toHaveBeenCalled()
  })

  it('publishes refreshed tokens only while the hydrated snapshot still owns the store', async () => {
    readAuthJsonMock.mockResolvedValue(authJsonSource('old', 10, 'old-refresh|project'))
    const hydrated = await hydrateGeminiOAuthPreparationSnapshot(true)
    const preparation = hydrated.value!

    await commitGeminiOAuthTokenRefresh(preparation, {
      accessToken: 'new',
      newRefreshToken: 'new-refresh',
      expiresIn: 3600
    })
    expect(getGeminiOAuthPreparationSnapshot().value).toMatchObject({
      auth: { access: 'new', refresh: 'new-refresh|project' }
    })
    expect(saveAuthJsonSourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/home/alice/.local/share/opencode/auth.json',
        value: expect.objectContaining({
          google: expect.objectContaining({ access: 'new', refresh: 'new-refresh|project' })
        })
      })
    )

    await hydrateGeminiOAuthPreparationSnapshot(false)
    await commitGeminiOAuthTokenRefresh(preparation, {
      accessToken: 'late',
      newRefreshToken: null
    })
    expect(getGeminiOAuthPreparationSnapshot()).toMatchObject({
      value: null,
      availability: 'missing'
    })
  })

  it('keeps refreshed tokens when disk credentials have not changed', async () => {
    const diskCredentials = {
      access_token: 'expired',
      refresh_token: 'disk-refresh',
      expiry_date: 10
    }
    readAuthJsonMock.mockResolvedValue(null)
    readGeminiCredentialsMock.mockResolvedValue(diskCredentials)
    const hydrated = await hydrateGeminiOAuthPreparationSnapshot(true)
    const preparation = hydrated.value!

    await commitGeminiOAuthTokenRefresh(preparation, {
      accessToken: 'memory-access',
      newRefreshToken: 'memory-refresh',
      expiresIn: 3600
    })
    await hydrateGeminiOAuthPreparationSnapshot(true)

    expect(getGeminiOAuthPreparationSnapshot().value).toMatchObject({
      credentials: {
        access_token: 'memory-access',
        refresh_token: 'memory-refresh'
      }
    })
    expect(saveGeminiCredentialsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        access_token: 'memory-access',
        refresh_token: 'memory-refresh'
      })
    )
  })

  it('does not publish a credential refresh when persistence fails', async () => {
    readAuthJsonMock.mockResolvedValue(null)
    readGeminiCredentialsMock.mockResolvedValue({
      access_token: 'expired',
      refresh_token: 'disk-refresh',
      expiry_date: 10
    })
    saveGeminiCredentialsMock.mockRejectedValue(new Error('disk unavailable'))
    const hydrated = await hydrateGeminiOAuthPreparationSnapshot(true)

    await expect(
      commitGeminiOAuthTokenRefresh(hydrated.value!, {
        accessToken: 'new-access',
        newRefreshToken: 'new-refresh',
        expiresIn: 3600
      })
    ).rejects.toThrow('disk unavailable')
    expect(getGeminiOAuthPreparationSnapshot().value).toMatchObject({
      credentials: { access_token: 'expired', refresh_token: 'disk-refresh' }
    })
  })

  it('serializes refresh persistence and discards stale concurrent commits', async () => {
    readAuthJsonMock.mockResolvedValue(null)
    readGeminiCredentialsMock.mockResolvedValue({
      access_token: 'expired',
      refresh_token: 'disk-refresh',
      expiry_date: 10
    })
    const write = deferred<void>()
    saveGeminiCredentialsMock.mockReturnValueOnce(write.promise)
    const hydrated = await hydrateGeminiOAuthPreparationSnapshot(true)

    const first = commitGeminiOAuthTokenRefresh(hydrated.value!, {
      accessToken: 'first-access',
      newRefreshToken: 'first-refresh',
      expiresIn: 3600
    })
    const second = commitGeminiOAuthTokenRefresh(hydrated.value!, {
      accessToken: 'second-access',
      newRefreshToken: 'second-refresh',
      expiresIn: 3600
    })
    await vi.waitFor(() => expect(saveGeminiCredentialsMock).toHaveBeenCalledTimes(1))
    write.resolve()
    await Promise.all([first, second])

    expect(saveGeminiCredentialsMock).toHaveBeenCalledTimes(1)
    expect(getGeminiOAuthPreparationSnapshot().value).toMatchObject({
      credentials: { access_token: 'first-access', refresh_token: 'first-refresh' }
    })
  })

  it('adopts credentials that changed on disk after an in-memory refresh', async () => {
    readAuthJsonMock.mockResolvedValue(null)
    readGeminiCredentialsMock.mockResolvedValue({
      access_token: 'old-disk',
      refresh_token: 'old-refresh',
      expiry_date: 10
    })
    const hydrated = await hydrateGeminiOAuthPreparationSnapshot(true)
    await commitGeminiOAuthTokenRefresh(hydrated.value!, {
      accessToken: 'memory-access',
      newRefreshToken: null,
      expiresIn: 3600
    })
    readGeminiCredentialsMock.mockResolvedValue({
      access_token: 'new-disk',
      refresh_token: 'new-refresh',
      expiry_date: 20
    })

    await hydrateGeminiOAuthPreparationSnapshot(true)

    expect(getGeminiOAuthPreparationSnapshot().value).toMatchObject({
      credentials: {
        access_token: 'new-disk',
        refresh_token: 'new-refresh'
      }
    })
  })
})
