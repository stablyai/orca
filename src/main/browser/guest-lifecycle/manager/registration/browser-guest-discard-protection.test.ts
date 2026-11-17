import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import {
  installBrowserGuestDiscardProtection,
  readBrowserGuestDiscardAdmission,
  readBrowserGuestDiscardProtection,
  registerBrowserSessionNotificationGrant,
  setBrowserGuestSemanticVisibility
} from './browser-guest-discard-protection'
import { reportBrowserSessionWebRequest } from '../../../sessions/requests/browser-session-web-request-observer'
import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

it('protects only the current document, never earlier history', () => {
  const frames: object[] = []
  let audible = false
  let crashed = false
  let url = 'about:blank'
  const mainFrame = { frames, send: vi.fn<(channel: string, generation: string) => void>() }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: event fixture implements this policy's native surface.
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame,
    session: {},
    getURL: () => url,
    isDestroyed: () => false,
    isCrashed: () => crashed,
    isCurrentlyAudible: () => audible
  }) as unknown as Electron.WebContents
  const changed = vi.fn()
  const stop = installBrowserGuestDiscardProtection(guest, changed)
  const report = (dirty: boolean): void => {
    const generation = mainFrame.send.mock.lastCall?.[1]
    guest.emit(
      'ipc-message',
      { sender: guest, senderFrame: mainFrame },
      BROWSER_GUEST_PROTECTION_REPORT,
      { generation, dirty, pictureInPicture: false, contentType: 'text/html' }
    )
  }
  const navigate = (next: string, status = 200, method = 'GET'): void => {
    url = next
    guest.emit('did-start-navigation', {
      url,
      frame: mainFrame,
      isMainFrame: true,
      isSameDocument: false
    })
    reportBrowserSessionWebRequest(guest.session, 'onBeforeRequest', {
      id: 1,
      url,
      method,
      frame: guest.mainFrame,
      resourceType: 'mainFrame',
      webContentsId: 7,
      timestamp: 0
    })
    guest.emit('did-navigate', {}, url, status, 'OK')
    guest.emit('dom-ready')
    report(false)
  }
  try {
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    navigate('https://example.test/a')
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    const firstGeneration = mainFrame.send.mock.lastCall?.[1]
    guest.emit('dom-ready')
    guest.emit(
      'ipc-message',
      { sender: guest, senderFrame: mainFrame },
      BROWSER_GUEST_PROTECTION_REPORT,
      { generation: firstGeneration, dirty: false, pictureInPicture: false, contentType: '' }
    )
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    guest.emit('ipc-message', { sender: guest, senderFrame: {} }, BROWSER_GUEST_PROTECTION_REPORT, {
      generation: mainFrame.send.mock.lastCall?.[1],
      dirty: false,
      pictureInPicture: false,
      contentType: 'text/html'
    })
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    report(false)
    audible = true
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('audio')
    audible = false
    Reflect.set(mainFrame, 'frames', undefined)
    guest.emit('frame-created')
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('frames')
    Object.defineProperty(mainFrame, 'frames', {
      configurable: true,
      get: () => {
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      }
    })
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('frames')
    Object.defineProperty(mainFrame, 'frames', {
      configurable: true,
      writable: true,
      value: frames
    })
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    frames.push({})
    guest.emit('frame-created')
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('frames')
    // Frame churn must not challenge every guest document or fan out unchanged protection.
    const challenges = mainFrame.send.mock.calls.length
    for (const count of [200, 2000]) {
      changed.mockClear()
      for (let event = 0; event < count; event++) {
        guest.emit('frame-created')
        guest.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
        guest.emit('did-stop-loading')
      }
      expect(changed).not.toHaveBeenCalled()
      expect(mainFrame.send).toHaveBeenCalledTimes(challenges)
    }
    frames.length = 0
    navigate('https://example.test/after-frame')
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    report(true)
    guest.emit('dom-ready')
    report(false)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    guest.emit('did-navigate-in-page', {}, 'https://example.test/after-frame#step', true)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    navigate('https://example.test/result', 200, 'POST')
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('post')
    // Earlier edited and POST pages, and non-2xx pages, do not keep the current page.
    navigate('https://example.test/missing', 404)
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    report(true)
    const oldGeneration = mainFrame.send.mock.lastCall?.[1]
    guest.emit('did-start-navigation', {
      url: 'https://example.test/aborted',
      frame: mainFrame,
      isMainFrame: true,
      isSameDocument: false
    })
    guest.emit('did-stop-loading')
    guest.emit(
      'ipc-message',
      { sender: guest, senderFrame: mainFrame },
      BROWSER_GUEST_PROTECTION_REPORT,
      { generation: oldGeneration, dirty: false, pictureInPicture: false, contentType: 'text/html' }
    )
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    report(false)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    guest.emit('unresponsive')
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    guest.emit('responsive')
    report(false)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    crashed = true
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('gone')
  } finally {
    stop()
  }
})

it('protects active page features from the private observer and at idle admission', () => {
  vi.useFakeTimers({ toFake: ['performance'] })
  const mainFrame = { frames: [], send: vi.fn<(channel: string, generation: string) => void>() }
  let url = 'https://example.test/'
  let audible = false
  let captured = false
  let loading = false
  const grants = new Set<string>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: event fixture implements this policy's native surface.
  const guest = Object.assign(new EventEmitter(), {
    id: 8,
    mainFrame,
    session: {},
    getURL: () => url,
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoading: () => loading,
    isBeingCaptured: () => captured,
    isCurrentlyAudible: () => audible
  }) as unknown as Electron.WebContents
  registerBrowserSessionNotificationGrant(guest.session, (pageUrl) =>
    grants.has(new URL(pageUrl).origin)
  )
  const stop = installBrowserGuestDiscardProtection(guest, vi.fn())
  const report = (fields: { pictureInPicture?: boolean; contentType?: string }): void => {
    guest.emit(
      'ipc-message',
      { sender: guest, senderFrame: mainFrame },
      BROWSER_GUEST_PROTECTION_REPORT,
      { generation: mainFrame.send.mock.lastCall?.[1], dirty: false, ...fields }
    )
  }
  const admission = (proactive = true): string =>
    readBrowserGuestDiscardAdmission(guest, proactive).reason
  try {
    guest.emit('did-start-navigation', {
      url,
      frame: mainFrame,
      isMainFrame: true,
      isSameDocument: false
    })
    guest.emit('did-navigate', {}, url, 200, 'OK')
    guest.emit('dom-ready')
    // An observer that predates these fields cannot prove the document safe.
    report({})
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    report({ pictureInPicture: true, contentType: 'text/html' })
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('picture-in-picture')
    report({ pictureInPicture: false, contentType: 'application/pdf' })
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('pdf')
    report({ pictureInPicture: false, contentType: 'text/html' })
    expect(admission()).toBe('clean')

    audible = true
    guest.emit('audio-state-changed', { audible })
    audible = false
    guest.emit('audio-state-changed', { audible })
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('clean')
    vi.advanceTimersByTime(59_000)
    expect(admission(false)).toBe('audio')
    vi.advanceTimersByTime(1_000)
    expect(admission(false)).toBe('clean')

    captured = true
    expect(admission(false)).toBe('capture')
    captured = false
    url = 'file:///Users/me/notes.html'
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('url')
    url = 'https://example.test/'
    grants.add('https://example.test')
    expect(admission(false)).toBe('clean')
    expect(admission()).toBe('notifications')
    grants.clear()

    // Load churn, visible pages and unreported visibility are not background activity.
    guest.emit('page-title-updated', {}, 'Inbox')
    setBrowserGuestSemanticVisibility(guest, true)
    guest.emit('page-title-updated', {}, 'Inbox (1)')
    setBrowserGuestSemanticVisibility(guest, false)
    loading = true
    guest.emit('page-title-updated', {}, 'Inbox (2)')
    guest.emit('page-favicon-updated', {}, ['https://example.test/a.ico'])
    loading = false
    guest.emit('page-title-updated', {}, 'Inbox (2)')
    expect(admission()).toBe('clean')
    guest.emit('page-favicon-updated', {}, ['https://example.test/unread.ico'])
    expect(admission()).toBe('background-activity')
    expect(admission(false)).toBe('clean')
    // Showing the page does not clear the background activity latch.
    setBrowserGuestSemanticVisibility(guest, true)
    expect(admission()).toBe('background-activity')
    // A new document starts clean, and its later background updates still count.
    setBrowserGuestSemanticVisibility(guest, false)
    guest.emit('did-navigate')
    loading = true
    guest.emit('page-title-updated', {}, 'Other page')
    loading = false
    expect(admission()).toBe('clean')
    guest.emit('page-favicon-updated', {}, ['https://example.test/a.ico'])
    expect(admission()).toBe('background-activity')
  } finally {
    stop()
    vi.useRealTimers()
  }
})
