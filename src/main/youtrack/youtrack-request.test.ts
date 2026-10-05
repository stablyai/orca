import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  defaultFetch: vi.fn(),
  insecureFetch: vi.fn()
}))

vi.mock('../network/http-client', () => ({
  getMainHttpClient: () => ({ fetch: mocks.defaultFetch, proxySession: () => null })
}))
vi.mock('../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: vi.fn(async () => undefined)
}))
const { setYouTrackInsecureTlsFetch, youtrackRequest } = await import('./youtrack-request')

const ok = (): Response => new Response(JSON.stringify({ login: 'me' }), { status: 200 })

describe('youtrackRequest TLS handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.defaultFetch.mockImplementation(async () => ok())
    mocks.insecureFetch.mockImplementation(async () => ok())
    setYouTrackInsecureTlsFetch(mocks.insecureFetch)
  })

  it('uses the shared client when certificate checks stay on', async () => {
    await youtrackRequest({ baseUrl: 'https://yt.corp', token: 't' }, '/api/users/me')
    expect(mocks.defaultFetch).toHaveBeenCalledOnce()
    expect(mocks.insecureFetch).not.toHaveBeenCalled()
  })

  it('routes through the host-scoped session when the user opted out of verification', async () => {
    await youtrackRequest(
      { baseUrl: 'https://yt.corp:8443/youtrack', token: 't', allowInsecureTls: true },
      '/api/users/me'
    )
    expect(mocks.insecureFetch).toHaveBeenCalledWith(
      'yt.corp',
      'https://yt.corp:8443/youtrack/api/users/me',
      expect.anything()
    )
    expect(mocks.defaultFetch).not.toHaveBeenCalled()
  })

  it('refuses the opt-out where no desktop transport exists', async () => {
    setYouTrackInsecureTlsFetch(null)
    await expect(
      youtrackRequest(
        { baseUrl: 'https://yt.corp', token: 't', allowInsecureTls: true },
        '/api/users/me'
      )
    ).rejects.toThrow(/desktop app/)
  })

  it('points certificate failures at the opt-out', async () => {
    mocks.defaultFetch.mockRejectedValue(new Error('net::ERR_CERT_AUTHORITY_INVALID'))
    await expect(
      youtrackRequest({ baseUrl: 'https://yt.corp', token: 't' }, '/api/users/me')
    ).rejects.toThrow(/Skip certificate verification/)
  })
})
