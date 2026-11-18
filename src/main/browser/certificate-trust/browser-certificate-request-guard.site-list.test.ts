import { describe, expect, it, vi } from 'vitest'

import { BrowserCertificateRequestGuard } from './browser-certificate-request-guard'
import {
  bindBrowserSessionToSiteListProfile,
  setBrowserProfileSiteList
} from '../sessions/site-list/browser-session-site-list'
import { watchDecisionBlockedMainFrames } from '../sessions/requests/browser-session-request-decisions'

type Listener = (
  details: Electron.OnBeforeRequestListenerDetails,
  callback: (response: Electron.CallbackResponse) => void
) => void

function guardedSession(profileId: string): {
  send: (url: string, mainFrame?: boolean) => unknown
} {
  let listener: Listener | null = null
  const session = {
    webRequest: {
      onBeforeRequest: (next: Listener | null) => {
        listener = next
      }
    }
  } as unknown as Electron.Session
  bindBrowserSessionToSiteListProfile(session, profileId)
  new BrowserCertificateRequestGuard({ onBlockedMainFrame: vi.fn() }).installSession(session)
  return {
    send: (url, mainFrame = false) => {
      const callback = vi.fn()
      listener?.(
        {
          id: 1,
          url,
          method: 'GET',
          webContentsId: 7,
          resourceType: mainFrame ? 'mainFrame' : 'xhr',
          referrer: '',
          timestamp: 1,
          uploadData: []
        },
        callback
      )
      return callback.mock.calls[0]?.[0]
    }
  }
}

describe('browser profile site list in the request guard', () => {
  it('cancels unlisted hosts, passes listed hosts and re-checks each redirect hop', () => {
    setBrowserProfileSiteList('profile-a', ['example.com', '*.cdn.example.com'])
    const { send } = guardedSession('profile-a')

    expect(send('https://example.com/app')).toEqual({})
    expect(send('https://a.cdn.example.com/x.js')).toEqual({})
    expect(send('https://tracker.test/pixel')).toEqual({ cancel: true })
    // A redirect from a listed host arrives as its own request for the target.
    expect(send('https://login.other.test/redirected')).toEqual({ cancel: true })
    expect(send('data:text/plain,ok')).toEqual({})
  })

  it('changes take effect without reinstalling and an empty list is unrestricted', () => {
    const { send } = guardedSession('profile-b')
    expect(send('https://anything.test/')).toEqual({})

    setBrowserProfileSiteList('profile-b', ['example.com'])
    expect(send('https://anything.test/')).toEqual({ cancel: true })

    setBrowserProfileSiteList('profile-b', [])
    expect(send('https://anything.test/')).toEqual({})
  })

  it('reports a blocked main frame as a client-blocked load failure', () => {
    setBrowserProfileSiteList('profile-c', ['example.com'])
    const onBlocked = vi.fn()
    watchDecisionBlockedMainFrames(7, onBlocked)
    const { send } = guardedSession('profile-c')

    expect(send('https://blocked.test/', true)).toEqual({ cancel: true })
    expect(onBlocked).toHaveBeenCalledWith('https://blocked.test/')
  })
})
