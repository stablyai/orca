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

  // Cache expiry can start a new read before the first request rejects the token.
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
