import { describe, expect, it, vi } from 'vitest'
import { googleAuthUserAgent } from './browser-google-auth-ua'
import { cleanElectronUserAgent, setupGoogleAuthUserAgentOverride } from './browser-session-ua'

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
  it('ablates the resolver on an image request while enforcing its per-guest value when enabled', () => {
    const mobileUa =
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/134.0.0.0 Mobile/15E148 Safari/604.1'
    const request = {
      url: 'https://example.com/logo.png',
      webContentsId: 44,
      requestHeaders: {
        'User-Agent': 'Electron/30 Chrome/134',
        'sec-ch-ua': 'browser-owned'
      }
    }

    // Ablation: with the new resolver disabled, the clean session identity is the only fallback.
    const disabled = runRequest(install(), structuredClone(request))
    expect(disabled['User-Agent']).toBe(
      cleanElectronUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) orca/1.0.0 Chrome/134.0.0.0 Electron/30.0.0 Safari/537.36'
      )
    )

    const resolver = vi.fn(() => mobileUa)
    const enabled = runRequest(install(resolver), structuredClone(request))
    expect(enabled['User-Agent']).toBe(mobileUa)
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ url: request.url, webContentsId: request.webContentsId })
    )
    // Negative control: the resolver does not alter Chromium-owned client hints.
    expect(enabled['sec-ch-ua']).toBe('browser-owned')
  })

  it('keeps Firefox across auth-document cross-host requests and strips its hints', () => {
    const listener = install(({ effectiveUserAgent }) => effectiveUserAgent)
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
    const resolver = vi.fn(() => 'unexpected Chrome identity')
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
