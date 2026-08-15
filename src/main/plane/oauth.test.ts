import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const closeMock = vi.hoisted(() => vi.fn())
const listeners = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
const openExternalMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({ shell: { openExternal: openExternalMock } }))

vi.mock('node:http', () => ({
  createServer: () => ({
    address: () => ({ port: 18181 }),
    close: closeMock,
    listen: (_port: number, _host: string, callback: () => void) => callback(),
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener),
    once: vi.fn()
  })
}))

describe('Plane OAuth flow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    closeMock.mockClear()
    listeners.clear()
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

  it('accepts valid callback requests', async () => {
    openExternalMock.mockResolvedValue(undefined)
    const { planeOAuthTestInternals } = await import('./oauth')
    const result = planeOAuthTestInternals.runOAuthCallback('https://plane.example', 'client-id')
    await Promise.resolve()
    const authUrl = new URL(openExternalMock.mock.calls[0]?.[0])
    const state = authUrl.searchParams.get('state')

    requestListener()({ url: `/plane/oauth/callback?code=code&state=${state}` }, responseMock())

    await expect(result).resolves.toMatchObject({ code: 'code' })
  })

  it('rejects callback requests with mismatched state', async () => {
    openExternalMock.mockResolvedValue(undefined)
    const { planeOAuthTestInternals } = await import('./oauth')
    const result = planeOAuthTestInternals.runOAuthCallback('https://plane.example', 'client-id')
    const rejection = expect(result).rejects.toThrow('Plane OAuth callback was invalid')
    await Promise.resolve()

    requestListener()({ url: '/plane/oauth/callback?code=code&state=wrong' }, responseMock())

    await rejection
  })

  it('surfaces callback provider errors', async () => {
    openExternalMock.mockResolvedValue(undefined)
    const { planeOAuthTestInternals } = await import('./oauth')
    const result = planeOAuthTestInternals.runOAuthCallback('https://plane.example', 'client-id')
    const rejection = expect(result).rejects.toThrow(
      'Plane OAuth failed: access_denied (User denied access)'
    )
    await Promise.resolve()

    requestListener()(
      { url: '/plane/oauth/callback?error=access_denied&error_description=User%20denied%20access' },
      responseMock()
    )

    await rejection
  })

  it('rejects callback requests with the wrong path', async () => {
    openExternalMock.mockResolvedValue(undefined)
    const { planeOAuthTestInternals } = await import('./oauth')
    const result = planeOAuthTestInternals.runOAuthCallback('https://plane.example', 'client-id')
    const rejection = expect(result).rejects.toThrow('Plane OAuth callback was invalid')
    await Promise.resolve()

    requestListener()({ url: '/wrong/path?code=code' }, responseMock())

    await rejection
  })
})

function requestListener(): (...args: unknown[]) => void {
  const listener = listeners.get('request')
  if (!listener) {
    throw new Error('Request listener was not registered')
  }
  return listener
}

function responseMock(): { writeHead: () => { end: () => void } } {
  return { writeHead: () => ({ end: vi.fn() }) }
}
