import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import {
  installBrowserGuestDiscardProtection,
  readBrowserGuestDiscardProtection
} from './browser-guest-discard-protection'
import { BROWSER_GUEST_PROTECTION_REPORT } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

it('binds edit protection to the current main-frame document and real lifecycle coverage', () => {
  const mainFrame = { frames: [] as object[], send: vi.fn() }
  let audible = false
  let crashed = false
  const guest = Object.assign(new EventEmitter(), {
    id: 7,
    mainFrame,
    isDestroyed: () => false,
    isCrashed: () => crashed,
    isCurrentlyAudible: () => audible
  }) as unknown as Electron.WebContents
  const stop = installBrowserGuestDiscardProtection(guest, vi.fn())
  const send = (payload: unknown, frame: unknown = mainFrame): void => {
    guest.emit(
      'ipc-message',
      { sender: guest, senderFrame: frame },
      BROWSER_GUEST_PROTECTION_REPORT,
      payload
    )
  }
  const generation = (): string => mainFrame.send.mock.lastCall?.[1] as string
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
    send({ generation: second, dirty: false })
    audible = true
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('audio')
    audible = false
    mainFrame.frames.push({})
    guest.emit('frame-created')
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
    guest.emit('responsive')
    send({ generation: generation(), dirty: true })
    expect(readBrowserGuestDiscardProtection(guest).reason).toBe('edits')
    crashed = true
    expect(readBrowserGuestDiscardProtection(guest).protection).toBe('gone')
  } finally {
    stop()
  }
})
