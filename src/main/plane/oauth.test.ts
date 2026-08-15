import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const closeMock = vi.hoisted(() => vi.fn())
const openExternalMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }))

vi.mock('node:http', () => ({
  createServer: () => ({
    address: () => ({ port: 18181 }),
    close: closeMock,
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    on: vi.fn(),
    once: vi.fn()
  })
}))

describe('Plane OAuth flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    closeMock.mockClear()
    openExternalMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('closes the callback server when browser launch fails', async () => {
    openExternalMock.mockRejectedValue(new Error('browser unavailable'))
    const { planeOAuthTestInternals } = await import('./oauth')

    await expect(
      planeOAuthTestInternals.runOAuthCallback('https://plane.example', 'client-id')
    ).rejects.toThrow('browser unavailable')

    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('closes the callback server when OAuth times out', async () => {
    openExternalMock.mockResolvedValue(undefined)
    const { planeOAuthTestInternals } = await import('./oauth')
    const result = planeOAuthTestInternals.runOAuthCallback('https://plane.example', 'client-id')
    const rejection = expect(result).rejects.toThrow('Plane OAuth timed out')

    await vi.advanceTimersByTimeAsync(120_000)

    await rejection
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('bounds the token exchange with a timeout signal', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
        status: 200
      })
    )
    const { planeOAuthTestInternals } = await import('./oauth')

    await planeOAuthTestInternals.exchangeCode('https://plane.example', {
      code: 'code',
      redirectUri: 'http://127.0.0.1:18181/plane/oauth/callback',
      clientId: 'client-id',
      clientSecret: 'client-secret'
    })

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal)
  })
})
