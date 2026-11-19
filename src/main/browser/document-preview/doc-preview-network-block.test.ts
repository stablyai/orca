import { describe, expect, it, vi } from 'vitest'

type BeforeRequest = (
  details: { url: string },
  callback: (response: { cancel?: boolean }) => void
) => void

const previewSession = vi.hoisted(() => {
  const listeners = new Map<string, unknown>()
  const record =
    (event: string) =>
    (...args: unknown[]): void => {
      listeners.set(event, args.at(-1))
    }
  return {
    listeners,
    protocol: { isProtocolHandled: () => false, handle: () => {} },
    webRequest: {
      onBeforeRequest: record('onBeforeRequest'),
      onBeforeSendHeaders: record('onBeforeSendHeaders')
    },
    on: () => {},
    removeListener: () => {},
    getUserAgent: () => 'Mozilla/5.0 Orca',
    setUserAgent: () => {},
    setPermissionRequestHandler: () => {},
    setPermissionCheckHandler: () => {},
    setDisplayMediaRequestHandler: () => {}
  }
})

vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: () => {} },
  session: { fromPartition: () => previewSession }
}))
vi.mock('../sessions/proxy/browser-session-proxy', () => ({
  applyProxyToBrowserSession: async () => {},
  invalidateBrowserSessionProxyApplication: () => {}
}))
vi.mock('../../network/proxy-settings', () => ({
  getProxySessionApplicationReadiness: () => true,
  clearProxySessionCredentials: () => {}
}))
vi.mock('../identity/requests/browser-session-ua', () => ({
  installBrowserSessionUserAgentPolicy: () => () => {}
}))
vi.mock('../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({ mode: 'native', userAgent: 'Mozilla/5.0 Orca' })
}))
vi.mock('../webauthn/browser-webauthn-access', () => ({
  allowsBrowserWebAuthnPermission: () => false,
  clearBrowserWebAuthnAccessHandlers: () => {},
  installBrowserWebAuthnAccessHandlers: () => {}
}))
// The real certificate guard, as the app's browser manager installs it on every browser session.
vi.mock('../guest-lifecycle/manager/browser-manager', async () => {
  const { BrowserCertificateRequestGuard } =
    await import('../certificate-trust/browser-certificate-request-guard')
  const guard = new BrowserCertificateRequestGuard({ onBlockedMainFrame: () => {} })
  return {
    browserManager: {
      installCertificateRequestGuard: (session: Electron.Session) => guard.installSession(session),
      removeCertificateRequestGuard: (session: Electron.Session) => guard.removeSession(session),
      handleGuestWillDownload: () => {}
    }
  }
})

function decide(url: string): { cancel?: boolean } {
  const listener = previewSession.listeners.get('onBeforeRequest') as BeforeRequest
  let response: { cancel?: boolean } = {}
  listener({ url }, (answer) => {
    response = answer
  })
  return response
}

describe('document preview network block', () => {
  it('keeps cancelling network requests after the preview session gets its browser policies', async () => {
    const { installDocPreviewProtocolHandler } = await import('./doc-preview-protocol')
    installDocPreviewProtocolHandler()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(decide('https://example.com/collect?secret=1')).toEqual({ cancel: true })
    expect(decide('ws://example.com/socket')).toEqual({ cancel: true })
    expect(decide('orca-preview://doc/index.html')).toEqual({ cancel: false })
  })
})
