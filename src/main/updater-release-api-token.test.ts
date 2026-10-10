import { beforeEach, describe, expect, it, vi } from 'vitest'

const ghExecMock = vi.fn()
vi.mock('./git/runner', () => ({
  ghExecFileWithScopeAsync: async (...args: unknown[]) => ({
    rateLimitScope: 'native:github.com',
    ...(await ghExecMock(...args))
  })
}))

const { _resetReleaseApiTokenCache, rejectReleaseApiToken, resolveReleaseApiToken } =
  await import('./updater-release-api-token')

const T0 = 1_000_000
const TTL_MS = 5 * 60_000

describe('resolveReleaseApiToken', () => {
  beforeEach(() => {
    ghExecMock.mockReset()
    _resetReleaseApiTokenCache()
  })

  it('reads the github.com token through gh and trims it', async () => {
    ghExecMock.mockResolvedValue({ stdout: 'gho_abc\n', stderr: '' })

    await expect(resolveReleaseApiToken(T0)).resolves.toEqual({
      token: 'gho_abc',
      rateLimitScope: 'native:github.com'
    })

    expect(ghExecMock.mock.calls[0][0]).toEqual(['auth', 'token', '--hostname', 'github.com'])
    expect(ghExecMock.mock.calls[0][1]).toMatchObject({ idempotent: false })
  })

  it('serves the cached token within its TTL and re-reads after it', async () => {
    ghExecMock.mockResolvedValue({ stdout: 'gho_abc', stderr: '' })

    await resolveReleaseApiToken(T0)
    await resolveReleaseApiToken(T0 + TTL_MS - 1)
    expect(ghExecMock).toHaveBeenCalledTimes(1)

    await resolveReleaseApiToken(T0 + TTL_MS + 1)
    expect(ghExecMock).toHaveBeenCalledTimes(2)
  })

  // Why: gh missing or logged out is the unauthenticated path the picker always
  // had; it must not fail the list, and it must not spawn gh on every click.
  it('returns null when gh is missing or logged out and does not re-spawn within the TTL', async () => {
    ghExecMock.mockRejectedValueOnce(new Error('gh: not found'))

    await expect(resolveReleaseApiToken(T0)).resolves.toBeNull()
    await expect(resolveReleaseApiToken(T0 + TTL_MS - 1)).resolves.toBeNull()
    expect(ghExecMock).toHaveBeenCalledTimes(1)

    ghExecMock.mockResolvedValueOnce({ stdout: 'gho_new', stderr: '' })
    await expect(resolveReleaseApiToken(T0 + TTL_MS + 1)).resolves.toEqual({
      token: 'gho_new',
      rateLimitScope: 'native:github.com'
    })
  })

  it('treats empty output as no token', async () => {
    ghExecMock.mockResolvedValue({ stdout: '\n', stderr: '' })

    await expect(resolveReleaseApiToken(T0)).resolves.toBeNull()
  })

  it('caches the successful WSL scope alongside the token', async () => {
    ghExecMock.mockResolvedValue({
      stdout: 'gho_wsl\n',
      stderr: '',
      rateLimitScope: 'wsl:ubuntu:github.com'
    })

    const expected = { token: 'gho_wsl', rateLimitScope: 'wsl:ubuntu:github.com' }
    await expect(resolveReleaseApiToken(T0)).resolves.toEqual(expected)
    await expect(resolveReleaseApiToken(T0 + TTL_MS - 1)).resolves.toEqual(expected)
    expect(ghExecMock).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight read between concurrent callers', async () => {
    let finish: (value: { stdout: string; stderr: string }) => void = () => {}
    ghExecMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )

    const first = resolveReleaseApiToken(T0)
    const second = resolveReleaseApiToken(T0)
    finish({ stdout: 'gho_abc', stderr: '' })

    await expect(Promise.all([first, second])).resolves.toEqual([
      { token: 'gho_abc', rateLimitScope: 'native:github.com' },
      { token: 'gho_abc', rateLimitScope: 'native:github.com' }
    ])
    expect(ghExecMock).toHaveBeenCalledTimes(1)
  })

  // Why: a token GitHub rejected would otherwise be re-read from the keyring
  // and re-sent on every load — one gh spawn and one wasted request each time.
  it('goes unauthenticated for a TTL after the token is rejected', async () => {
    ghExecMock.mockResolvedValue({ stdout: 'gho_stale', stderr: '' })
    await expect(resolveReleaseApiToken(T0)).resolves.toEqual({
      token: 'gho_stale',
      rateLimitScope: 'native:github.com'
    })

    rejectReleaseApiToken(T0)

    await expect(resolveReleaseApiToken(T0 + TTL_MS - 1)).resolves.toBeNull()
    expect(ghExecMock).toHaveBeenCalledTimes(1)
    await expect(resolveReleaseApiToken(T0 + TTL_MS + 1)).resolves.toEqual({
      token: 'gho_stale',
      rateLimitScope: 'native:github.com'
    })
    expect(ghExecMock).toHaveBeenCalledTimes(2)
  })

  // Why: the cache can expire mid-fetch, so a second load starts a fresh read while
  // the first is still waiting on the 401 that rejects the token. Without the
  // generation guard that read writes the rejected token back over the rejection.
  it('keeps the rejection when a read that started before it resolves', async () => {
    let finish: (value: { stdout: string; stderr: string }) => void = () => {}
    ghExecMock.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )

    const inFlight = resolveReleaseApiToken(T0)
    rejectReleaseApiToken(T0)
    finish({ stdout: 'gho_stale', stderr: '' })

    await expect(inFlight).resolves.toBeNull()
    await expect(resolveReleaseApiToken(T0 + TTL_MS - 1)).resolves.toBeNull()
    expect(ghExecMock).toHaveBeenCalledTimes(1)
  })
})
