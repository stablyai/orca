import { describe, expect, it, vi } from 'vitest'
import { googleAuthUserAgent } from './browser-google-auth-ua'
import { cleanElectronUserAgent, setupGoogleAuthUserAgentOverride } from './browser-session-ua'
import { buildViewportUserAgentOverride } from './browser-viewport-user-agent'

type RequestDetails = {
  url: string
  webContentsId?: number
  webContents?: { getUserAgent: () => string }
  requestHeaders: Record<string, string>
}

type RequestListener = (
  details: RequestDetails,
  callback: (response: { requestHeaders: Record<string, string> }) => void
) => void

function install(resolveRequestUserAgent?: Parameters<typeof setupGoogleAuthUserAgentOverride>[1]) {
  const onBeforeSendHeaders = vi.fn()
  const sess = {
    getUserAgent: vi.fn(
      () =>
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
    ),
    webRequest: { onBeforeSendHeaders }
  }
  setupGoogleAuthUserAgentOverride(sess as never, resolveRequestUserAgent)
  return onBeforeSendHeaders.mock.calls[0][1] as RequestListener
}

function runRequest(listener: RequestListener, details: RequestDetails): Record<string, string> {
  const callback = vi.fn()
  listener(details, callback)
  return callback.mock.calls[0][0].requestHeaders
}

describe('browser session request identity', () => {
  it('ablates the resolver on a worker request while enforcing its mobile identity when enabled', () => {
    const mobileIdentity = buildViewportUserAgentOverride({
      url: 'https://example.com/worker-beacon',
      mobile: true,
      baseUserAgent: 'Chrome/134.0.0.0'
    })
    const request = {
      url: 'https://example.com/worker-beacon',
      requestHeaders: {
        'User-Agent': 'Electron/30 Chrome/134',
        'sec-ch-ua': 'desktop brands',
        'sec-ch-ua-full-version-list': 'desktop versions',
        'sec-ch-ua-platform': '"macOS"',
        'sec-ch-ua-platform-version': '"15.0.0"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-model': '""',
        'sec-ch-ua-form-factors': '"Desktop"'
      }
    }

    // Ablation: with the new resolver disabled, the clean session identity is the only fallback.
    const disabled = runRequest(install(), structuredClone(request))
    expect(disabled['User-Agent']).toBe(
      cleanElectronUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
      )
    )
    expect(disabled['sec-ch-ua-platform']).toBe('"macOS"')

    const resolver = vi.fn(() => mobileIdentity)
    const enabled = runRequest(install(resolver), structuredClone(request))
    expect(enabled['User-Agent']).toBe(mobileIdentity.userAgent)
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ url: request.url, webContentsId: undefined })
    )
    expect(enabled['sec-ch-ua']).toContain('"Google Chrome";v="134"')
    expect(enabled['sec-ch-ua-full-version-list']).toContain('"Google Chrome";v="134.0.0.0"')
    expect(enabled['sec-ch-ua-platform']).toBe('"iOS"')
    expect(enabled['sec-ch-ua-platform-version']).toBe('"17.0"')
    expect(enabled['sec-ch-ua-mobile']).toBe('?1')
    expect(enabled['sec-ch-ua-model']).toBe('"iPhone"')
    expect(enabled['sec-ch-ua-form-factors']).toBeUndefined()
  })

  it('keeps Firefox across auth-document cross-host requests and strips its hints', () => {
    const listener = install(({ effectiveUserAgent }) =>
      effectiveUserAgent ? { userAgent: effectiveUserAgent } : undefined
    )
    const headers = runRequest(listener, {
      url: 'https://www.gstatic.com/_/signin/log',
      webContentsId: 7,
      requestHeaders: {
        'User-Agent': googleAuthUserAgent(),
        'sec-ch-ua': 'browser-owned',
        'sec-ch-ua-platform': '"macOS"'
      },
      webContents: { getUserAgent: () => googleAuthUserAgent() } as never
    })
    expect(headers['User-Agent']).toBe(googleAuthUserAgent())
    expect(headers['sec-ch-ua']).toBeUndefined()
    expect(headers['sec-ch-ua-platform']).toBeUndefined()
  })

  it('keeps the Firefox auth-host branch independent of the resolver', () => {
    const resolver = vi.fn(() => ({ userAgent: 'unexpected Chrome identity' }))
    const headers = runRequest(install(resolver), {
      url: 'https://accounts.google.com/v3/signin/identifier',
      requestHeaders: {
        'User-Agent': 'Chrome/134',
        'sec-ch-ua': 'browser-owned'
      }
    })
    expect(headers['User-Agent']).toBe(googleAuthUserAgent())
    expect(headers['sec-ch-ua']).toBeUndefined()
    expect(resolver).not.toHaveBeenCalled()
  })
})
