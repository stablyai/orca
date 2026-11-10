import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import {
  installBrowserGuestDiscardProtection,
  readBrowserGuestDiscardProtection
} from './browser-guest-discard-protection'
import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

it('binds edit protection to the current main-frame document and real lifecycle coverage', () => {
  const frames: object[] = []
  const mainFrame = { frames, send: vi.fn<(channel: string, generation: string) => void>() }
  let audible = false
  let crashed = false
  let historyLength = 1
  let historyUnavailable = false
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The EventEmitter fixture implements all WebContents methods used by this owner.
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame,
    navigationHistory: {
      length: () => {
        if (historyUnavailable) {
          throw new Error('History unavailable')
        }
        return historyLength
      }
    },
    isDestroyed: () => false,
    isCrashed: () => crashed,
    isCurrentlyAudible: () => audible
  }) as unknown as Electron.WebContents
  const changed = vi.fn()
  const stop = installBrowserGuestDiscardProtection(guest, changed)
  const send = (payload: unknown, frame: unknown = mainFrame): void => {
    guest.emit(
      'ipc-message',
      { sender: guest, senderFrame: frame },
      BROWSER_GUEST_PROTECTION_REPORT,
      payload
    )
  }
  const generation = (): string => {
    const value = mainFrame.send.mock.lastCall?.[1]
    if (value === undefined) {
      throw new Error('No document challenge was sent')
    }
    return value
  }
  try {
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    send({ ready: true })
    const first = generation()
    send({ generation: first, dirty: false }, {})
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    send({ generation: first, dirty: false })
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    send({ generation: first, dirty: true })
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    guest.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    send({ generation: first, dirty: false })
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    // An aborted navigation keeps the surviving observer's draft, under a fresh challenge.
    guest.emit('did-stop-loading')
    const second = generation()
    expect(second).not.toBe(first)
    send({ generation: first, dirty: false })
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    send({ generation: second, dirty: true })
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    guest.emit('dom-ready')
    send({ generation: generation(), dirty: false })
    audible = true
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('audio')
    audible = false
    historyLength = 2
    guest.emit('did-navigate-in-page', {}, 'https://example.test/step-2', true)
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('history')
    changed.mockClear()
    guest.emit('did-navigate-in-page', {}, 'https://example.test/step-3', true)
    expect(changed).not.toHaveBeenCalled()
    historyUnavailable = true
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    historyUnavailable = false
    historyLength = 1
    mainFrame.frames.push({})
    guest.emit('frame-created')
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
    send({ generation: generation(), dirty: false })
    expect(readBrowserGuestDiscardProtection(guest)).toEqual({
      webContentsId: 7,
      protection: 'unknown',
      reason: 'frames'
    })
    mainFrame.frames.length = 0
    guest.emit('did-stop-loading')
    send({ generation: generation(), dirty: false })
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('discardable')
    guest.emit('unresponsive')
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('unknown')
    changed.mockClear()
    guest.emit('responsive')
    expect(changed).toHaveBeenCalledTimes(1)
    send({ generation: generation(), dirty: true })
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    crashed = true
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('gone')
  } finally {
    stop()
  }
})
