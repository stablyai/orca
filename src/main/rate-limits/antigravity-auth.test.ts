import { beforeEach, describe, expect, it, vi } from 'vitest'
import { basename, join } from 'node:path'

const {
  readKeyringMock,
  writeKeyringMock,
  readFileMock,
  writeFileMock,
  renameMock,
  rmMock,
  netFetchMock
} = vi.hoisted(() => ({
  readKeyringMock: vi.fn(),
  writeKeyringMock: vi.fn(),
  readFileMock: vi.fn(),
  writeFileMock: vi.fn(),
  renameMock: vi.fn(),
  rmMock: vi.fn(),
  netFetchMock: vi.fn()
}))

vi.mock('./antigravity-keychain', () => ({
  readAntigravityKeyring: readKeyringMock,
  writeAntigravityKeyring: writeKeyringMock
}))

vi.mock('node:fs/promises', () => ({
  readFile: readFileMock,
  writeFile: writeFileMock,
  rename: renameMock,
  rm: rmMock
}))

vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import {
  getAntigravityAccessToken,
  invalidateAntigravityAccessToken,
  readAntigravityCredentials,
  type AntigravityCredentialSource
} from './antigravity-auth'

function credentialRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    auth_method: 'consumer',
    token: {
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      expiry: '2026-08-01T12:00:00.000Z',
      token_type: 'Bearer'
    },
    ...overrides
  }
}

function keyringValue(record = credentialRecord()): string {
  return `go-keyring-base64:${Buffer.from(JSON.stringify(record), 'utf8').toString('base64')}`
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response
}

let homeCounter = 0
function testHome(): string {
  homeCounter += 1
  return `/tmp/antigravity-auth-test-${homeCounter}`
}

describe('Antigravity credential authority', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T11:00:00.000Z'))
    readKeyringMock.mockReset()
    writeKeyringMock.mockReset()
    readFileMock.mockReset()
    writeFileMock.mockReset()
    renameMock.mockReset()
    rmMock.mockReset()
    netFetchMock.mockReset()
    readKeyringMock.mockResolvedValue({ status: 'missing' })
    readFileMock.mockRejectedValue({ code: 'ENOENT' })
    writeKeyringMock.mockResolvedValue(undefined)
    writeFileMock.mockResolvedValue(undefined)
    renameMock.mockResolvedValue(undefined)
    rmMock.mockResolvedValue(undefined)
  })

  it('reads the official keyring before the token file', async () => {
    const home = testHome()
    readKeyringMock.mockResolvedValue({ status: 'found', value: keyringValue() })

    const result = await readAntigravityCredentials(home)

    expect(result.source satisfies AntigravityCredentialSource).toBe('official-keychain')
    expect(result.accessToken).toBe('access-token')
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it('falls back only to the official token file when the keyring is missing', async () => {
    const home = testHome()
    const raw = JSON.stringify(credentialRecord())
    readFileMock.mockResolvedValue(raw)
    const controller = new AbortController()

    const result = await readAntigravityCredentials(home, controller.signal)

    expect(result.source).toBe('official-token-file')
    expect(readFileMock).toHaveBeenCalledWith(
      join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
      { encoding: 'utf8', signal: controller.signal }
    )
  })

  it('does not treat an unrelated auth file as an Antigravity credential', async () => {
    const home = testHome()
    readFileMock.mockImplementation(async (filePath: string) => {
      if (basename(filePath) === 'antigravity-oauth-token') {
        throw { code: 'ENOENT' }
      }
      return JSON.stringify(credentialRecord())
    })

    await expect(readAntigravityCredentials(home)).rejects.toMatchObject({
      failureKind: 'missing-credentials'
    })
  })

  it('treats numeric Unix-second expiry values as epoch milliseconds', async () => {
    const home = testHome()
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + 3_600
    readKeyringMock.mockResolvedValue({
      status: 'found',
      value: keyringValue({
        token: { access_token: 'fresh-access-token', expiry: expiresAtSeconds }
      })
    })

    await expect(getAntigravityAccessToken({ baseHomeDir: home })).resolves.toMatchObject({
      accessToken: 'fresh-access-token'
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('shares one refresh request across concurrent callers', async () => {
    const home = testHome()
    readKeyringMock.mockResolvedValue({
      status: 'found',
      value: keyringValue({
        token: {
          access_token: 'expired-access-token',
          refresh_token: 'refresh-token',
          expiry: '2026-08-01T09:00:00.000Z'
        }
      })
    })
    let resolveRefresh!: (value: Response) => void
    netFetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveRefresh = resolve
      })
    )

    const first = getAntigravityAccessToken({ baseHomeDir: home })
    const second = getAntigravityAccessToken({ baseHomeDir: home })
    await vi.advanceTimersByTimeAsync(0)

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    resolveRefresh(response({ access_token: 'refreshed-access-token', expires_in: 3600 }))

    await expect(first).resolves.toMatchObject({ accessToken: 'refreshed-access-token' })
    await expect(second).resolves.toMatchObject({ accessToken: 'refreshed-access-token' })
  })

  it('lets a remaining caller keep a shared refresh alive after another aborts', async () => {
    const home = testHome()
    readKeyringMock.mockResolvedValue({
      status: 'found',
      value: keyringValue({
        token: {
          access_token: 'expired-access-token',
          refresh_token: 'refresh-token',
          expiry: '2026-08-01T09:00:00.000Z'
        }
      })
    })
    let resolveRefresh!: (value: Response) => void
    netFetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveRefresh = resolve
      })
    )
    const firstController = new AbortController()
    const first = getAntigravityAccessToken({
      baseHomeDir: home,
      signal: firstController.signal
    })
    const second = getAntigravityAccessToken({ baseHomeDir: home })
    await vi.advanceTimersByTimeAsync(0)

    firstController.abort()
    await expect(first).rejects.toMatchObject({ name: 'AbortError' })
    const refreshCall = netFetchMock.mock.calls[0]
    expect(refreshCall?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const refreshOptions = refreshCall?.[1] as RequestInit | undefined
    expect(refreshOptions?.signal?.aborted).toBe(false)

    resolveRefresh(response({ access_token: 'refreshed-access-token', expires_in: 3600 }))
    await expect(second).resolves.toMatchObject({ accessToken: 'refreshed-access-token' })
  })

  it('persists a rotated refresh token back to the official keyring', async () => {
    const home = testHome()
    readKeyringMock.mockResolvedValue({
      status: 'found',
      value: keyringValue({
        token: {
          access_token: 'expired-access-token',
          refresh_token: 'old-refresh-token',
          expiry: '2026-08-01T09:00:00.000Z'
        }
      })
    })
    netFetchMock.mockResolvedValue(
      response({
        access_token: 'refreshed-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      })
    )

    await expect(getAntigravityAccessToken({ baseHomeDir: home })).resolves.toMatchObject({
      credentialSource: 'official-keychain'
    })
    expect(writeKeyringMock).toHaveBeenCalledTimes(1)
    const written = String(writeKeyringMock.mock.calls[0]?.[0])
    expect(written.startsWith('go-keyring-base64:')).toBe(true)
    const decoded = JSON.parse(
      Buffer.from(written.slice('go-keyring-base64:'.length), 'base64').toString('utf8')
    ) as { token: { refresh_token: string } }
    expect(decoded.token.refresh_token).toBe('new-refresh-token')
  })

  it('continues credential persistence after the only consumer aborts', async () => {
    const home = testHome()
    readKeyringMock.mockResolvedValue({
      status: 'found',
      value: keyringValue({
        token: {
          access_token: 'expired-access-token',
          refresh_token: 'old-refresh-token',
          expiry: '2026-08-01T09:00:00.000Z'
        }
      })
    })
    let resolveWrite!: () => void
    writeKeyringMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveWrite = resolve
      })
    )
    netFetchMock.mockResolvedValue(
      response({
        access_token: 'refreshed-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      })
    )
    const controller = new AbortController()
    const pending = getAntigravityAccessToken({ baseHomeDir: home, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    expect(writeKeyringMock).toHaveBeenCalledTimes(1)

    controller.abort()
    resolveWrite()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(writeKeyringMock.mock.calls[0]?.[1]).toBeUndefined()
  })

  it('removes a temporary token file when the atomic rename fails', async () => {
    const home = testHome()
    readKeyringMock.mockResolvedValue({ status: 'missing' })
    readFileMock.mockResolvedValue(
      JSON.stringify(
        credentialRecord({
          token: {
            access_token: 'expired-access-token',
            refresh_token: 'old-refresh-token',
            expiry: '2026-08-01T09:00:00.000Z'
          }
        })
      )
    )
    renameMock.mockRejectedValue(new Error('rename failed'))
    netFetchMock.mockResolvedValue(
      response({
        access_token: 'refreshed-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600
      })
    )

    await expect(getAntigravityAccessToken({ baseHomeDir: home })).rejects.toMatchObject({
      failureKind: 'keychain-unavailable'
    })
    expect(rmMock).toHaveBeenCalledWith(
      `${join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token')}.${process.pid}.tmp`,
      { force: true }
    )
  })

  it('re-reads the official authority after an access token is invalidated', async () => {
    const home = testHome()
    readKeyringMock.mockResolvedValue({
      status: 'found',
      value: keyringValue({ token: { access_token: 'first-access-token' } })
    })
    const first = await getAntigravityAccessToken({ baseHomeDir: home })

    readKeyringMock.mockResolvedValue({
      status: 'found',
      value: keyringValue({ token: { access_token: 'new-access-token' } })
    })
    invalidateAntigravityAccessToken(first.sourceKey)

    await expect(getAntigravityAccessToken({ baseHomeDir: home })).resolves.toMatchObject({
      accessToken: 'new-access-token'
    })
    expect(readKeyringMock).toHaveBeenCalledTimes(2)
  })
})
