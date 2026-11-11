import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import {
  installBrowserGuestDiscardProtection,
  readBrowserGuestDiscardProtection,
  markInitialBrowserGuest
} from './browser-guest-discard-protection'
import { reportBrowserSessionWebRequest } from '../../../sessions/requests/browser-session-web-request-observer'
import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

it('retains earlier drafts and POST/unknown history while admitting observed clean GET history', () => {
  const frames: object[] = []
  let audible = false
  let crashed = false
  const mainFrame = { frames, send: vi.fn<(channel: string, generation: string) => void>() }
  let length = 1
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: event fixture implements this policy's native surface.
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame,
    session: {},
    isDestroyed: () => false,
    isCrashed: () => crashed,
    isCurrentlyAudible: () => audible,
    navigationHistory: { length: () => length, getActiveIndex: () => length - 1 }
  }) as unknown as Electron.WebContents
  markInitialBrowserGuest(guest)
  const changed = vi.fn()
  const stop = installBrowserGuestDiscardProtection(guest, changed)
  const report = (dirty: boolean): void => {
    const generation = mainFrame.send.mock.lastCall?.[1]
    guest.emit(
      'ipc-message',
      { sender: guest, senderFrame: mainFrame },
      BROWSER_GUEST_PROTECTION_REPORT,
      { generation, dirty }
    )
  }
  let requestId = 0
  const navigate = (url: string, method = 'GET', committed = true): void => {
    guest.emit('did-start-navigation', {
      url,
      frame: mainFrame,
      isMainFrame: true,
      isSameDocument: false
    })
    const details = {
      id: ++requestId,
      url,
      method,
      frame: guest.mainFrame,
      resourceType: 'mainFrame',
      webContentsId: 7,
      timestamp: 0
    }
    reportBrowserSessionWebRequest(guest.session, 'onBeforeRequest', details)
    if (committed) {
      guest.emit('did-navigate', {}, url, 200, 'OK')
    }
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
      { generation: firstGeneration, dirty: false }
    )
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    guest.emit('ipc-message', { sender: guest, senderFrame: {} }, BROWSER_GUEST_PROTECTION_REPORT, {
      generation: mainFrame.send.mock.lastCall?.[1],
      dirty: false
    })
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    report(false)
    audible = true
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('audio')
    audible = false
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
    length = 2
    navigate('https://example.test/after-frame')
    frames.length = 0
    report(false)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('history')
    length = 1
    navigate('https://example.test/sole-clean')
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    length = 2
    navigate('https://example.test/b')
    guest.emit('did-navigate-in-page', {}, 'https://example.test/b#step', true)
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    report(true)
    length = 3
    navigate('https://example.test/c')
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('history')
    guest.emit('dom-ready')
    report(false)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('history')
    length = 1
    navigate('https://example.test/clean')
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    navigate('https://example.test/post', 'POST')
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('history')
    length = 2
    navigate('https://example.test/after-post')
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('history')
    length = 1
    navigate('https://example.test/new-sole-get')
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    navigate('https://example.test/uncommitted', 'GET', false)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('history')
    navigate('https://example.test/overlap')
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('history')
    navigate('https://example.test/settled')
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    report(true)
    guest.emit('dom-ready')
    report(false)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
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
      { generation: oldGeneration, dirty: false }
    )
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    report(false)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    guest.emit('unresponsive')
    guest.emit('responsive')
    report(false)
    expect(readBrowserGuestDiscardProtection(guest).protection).not.toBe('discardable')
    crashed = true
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('gone')
  } finally {
    stop()
  }
})
