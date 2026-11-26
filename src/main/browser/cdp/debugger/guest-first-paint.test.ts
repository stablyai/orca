import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { waitForGuestFirstPaint } from './guest-first-paint'

function createFakeEmbeddedGuest(): {
  guest: WebContents
  emitNavigation: (isInPlace: boolean, isMainFrame: boolean) => void
} {
  const emitter = new EventEmitter()
  const guest = Object.assign(emitter, {
    getType: () => 'webview',
    isDestroyed: () => false
  })
  return {
    // Minimal stub matching the subset of WebContents that waitForGuestFirstPaint touches.
    guest: Object.setPrototypeOf(guest, EventEmitter.prototype),
    emitNavigation: (isInPlace: boolean, isMainFrame: boolean) => {
      emitter.emit('did-start-navigation', {}, 'https://example.com/next', isInPlace, isMainFrame)
    }
  }
}

describe('waitForGuestFirstPaint', () => {
  it('caches painted embedded guests across inputs and invalidates only on main-frame navigation', async () => {
    const { guest, emitNavigation } = createFakeEmbeddedGuest()
    const send = vi.fn(async () => ({ result: { value: [true, 100] } }))
    const holdPaint = vi.fn(() => () => {})

    await waitForGuestFirstPaint(guest, send, holdPaint)
    await waitForGuestFirstPaint(guest, send, holdPaint)
    expect(send).toHaveBeenCalledTimes(1)
    expect(holdPaint).not.toHaveBeenCalled()

    // Same-document and subframe navigations keep the painted cache warm.
    emitNavigation(true, true)
    emitNavigation(false, false)
    await waitForGuestFirstPaint(guest, send, holdPaint)
    expect(send).toHaveBeenCalledTimes(1)

    // Cross-document main-frame navigation invalidates the cache so the new document is probed.
    emitNavigation(false, true)
    await waitForGuestFirstPaint(guest, send, holdPaint)
    expect(send).toHaveBeenCalledTimes(2)
  })
})
