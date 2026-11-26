import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it } from 'vitest'
import {
  forgetBrowserGuestInputGestures,
  primeSyntheticBrowserGuestGesture,
  trackBrowserGuestInputGesture
} from '../input/browser-guest-input-gesture'
import { isNewBrowserTabPopupIntent, waitsForPopupOpener } from './browser-popup-new-tab-intent'

describe('browser-popup-new-tab-intent', () => {
  it('keeps Google Identity Services ux_mode=popup URLs attached to their opener', () => {
    expect(
      isNewBrowserTabPopupIntent({
        url: 'https://accounts.google.com/gsi/select?client_id=123.apps.googleusercontent.com&ux_mode=popup&ui_mode=card',
        frameName: '',
        disposition: 'foreground-tab'
      })
    ).toBe(false)
  })

  it('keeps standard OAuth authorization URLs attached to their opener', () => {
    expect(
      isNewBrowserTabPopupIntent({
        url: 'https://auth.example.com/authorize?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost%3A8400&response_type=code',
        frameName: '',
        disposition: 'foreground-tab'
      })
    ).toBe(false)
  })

  it('waits for child opener on foreground-tab opens from paired mobile viewers', () => {
    const request = {
      url: 'https://accounts.google.com/o/oauth2/chooseaccount',
      frameName: '',
      disposition: 'foreground-tab'
    }
    expect(
      waitsForPopupOpener(request, {
        byAgent: true,
        fromThisDesktop: false,
        fromPairedViewer: true
      })
    ).toBe(true)
    expect(
      waitsForPopupOpener(request, {
        byAgent: true,
        fromThisDesktop: false,
        fromPairedViewer: false
      })
    ).toBe(false)
    expect(waitsForPopupOpener(request, null)).toBe(false)
  })

  it('arms a single-use paired-viewer gesture for DOM-activated mobile taps', () => {
    const emitter = new EventEmitter()
    const fakeGuest: WebContents = Object.setPrototypeOf(
      Object.assign(emitter, { id: 77 }),
      EventEmitter.prototype
    )
    const tracker = trackBrowserGuestInputGesture(fakeGuest, { now: () => 1_000 })
    forgetBrowserGuestInputGestures(fakeGuest)
    primeSyntheticBrowserGuestGesture(
      fakeGuest,
      { byAgent: true, fromThisDesktop: false, fromPairedViewer: true },
      1_000
    )

    expect(tracker.consume()).toEqual({
      byAgent: true,
      fromThisDesktop: false,
      fromPairedViewer: true
    })
    // Single-use: a second window.open without another tap receives null.
    expect(tracker.consume()).toBeNull()
    tracker.dispose()
  })
})
