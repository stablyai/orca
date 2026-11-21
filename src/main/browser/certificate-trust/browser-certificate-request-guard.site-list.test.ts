import { describe, expect, it, vi } from 'vitest'

import { BrowserCertificateRequestGuard } from './browser-certificate-request-guard'
import {
  bindBrowserSessionToSiteListProfile,
  setBrowserProfileSiteList
} from '../sessions/site-list/browser-session-site-list'
import {
  setBrowserSessionRequestDecider,
  watchDecisionBlockedMainFrames
} from '../sessions/requests/browser-session-request-decisions'

type Listener = (
  details: Partial<Electron.OnBeforeRequestListenerDetails>,
  callback: (response: Electron.CallbackResponse) => void
) => void

// Only webRequest is exercised; the guard never touches the rest of a Session.
function isSession(value: { webRequest: unknown }): value is Electron.Session {
  return typeof value.webRequest === 'object'
}

describe('browser profile site list in the request guard', () => {
  it('cancels hosts outside the list, reports a blocked main frame, and lets an empty list through', () => {
    let listener: Listener | null = null
    const fakeSession = {
      webRequest: { onBeforeRequest: (next: Listener) => (listener = next) }
    }
    if (!isSession(fakeSession)) {
      throw new Error('unreachable')
    }
    const session = fakeSession
    bindBrowserSessionToSiteListProfile(session, 'profile-a')
    new BrowserCertificateRequestGuard({ onBlockedMainFrame: vi.fn() }).installSession(session)
    const onBlocked = vi.fn()
    watchDecisionBlockedMainFrames(7, onBlocked)
    const send = (
      url: string,
      resourceType: Electron.OnBeforeRequestListenerDetails['resourceType'] = 'xhr'
    ): unknown => {
      const callback = vi.fn()
      listener?.({ url, resourceType, webContentsId: 7 }, callback)
      return callback.mock.calls[0]?.[0]
    }

    setBrowserProfileSiteList('profile-a', ['example.com', '*.cdn.example.com'])
    expect(send('https://example.com/app')).toEqual({})
    expect(send('https://a.cdn.example.com/x.js')).toEqual({})
    expect(send('https://tracker.test/pixel')).toEqual({ cancel: true })
    expect(send('https://blocked.test/', 'mainFrame')).toEqual({ cancel: true })
    expect(onBlocked).toHaveBeenCalledWith('https://blocked.test/', 'site-list')

    setBrowserProfileSiteList('profile-a', [])
    expect(send('https://tracker.test/pixel')).toEqual({})
  })

  it('re-checks the list after an extension decision that was still pending', async () => {
    const installed: { listener: Listener | null } = { listener: null }
    const fakeSession = {
      webRequest: { onBeforeRequest: (next: Listener) => (installed.listener = next) }
    }
    if (!isSession(fakeSession)) {
      throw new Error('unreachable')
    }
    const session = fakeSession
    bindBrowserSessionToSiteListProfile(session, 'profile-b')
    new BrowserCertificateRequestGuard({ onBlockedMainFrame: vi.fn() }).installSession(session)
    let settle: (response: Electron.CallbackResponse) => void = () => {}
    const decider = {
      beforeRequest: () => new Promise<Electron.CallbackResponse>((resolve) => (settle = resolve)),
      beforeSendHeaders: (_s: Electron.Session, _d: unknown, headers: Record<string, string>) =>
        headers,
      headersReceived: () => null
    }
    setBrowserSessionRequestDecider(decider)
    try {
      setBrowserProfileSiteList('profile-b', ['example.com'])
      const callback = vi.fn()
      installed.listener?.({ url: 'https://example.com/', resourceType: 'xhr' }, callback)
      setBrowserProfileSiteList('profile-b', ['other.test'])
      settle({})
      await vi.waitFor(() => expect(callback).toHaveBeenCalled())
      expect(callback.mock.calls[0][0]).toEqual({ cancel: true })
    } finally {
      setBrowserSessionRequestDecider(null)
    }
  })
})
