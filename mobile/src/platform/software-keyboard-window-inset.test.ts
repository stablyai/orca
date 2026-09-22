import { describe, expect, it } from 'vitest'
import { softwareKeyboardWindowInset } from './software-keyboard-window-inset'

describe('the strip of the window the software keyboard takes', () => {
  it('is nothing while the keyboard is closed', () => {
    expect(
      softwareKeyboardWindowInset({ keyboardHeight: 0, bottomInset: 48, platform: 'android' })
    ).toBe(0)
  })

  it('is the iOS frame height as reported, which already spans the home indicator', () => {
    expect(
      softwareKeyboardWindowInset({ keyboardHeight: 336, bottomInset: 34, platform: 'ios' })
    ).toBe(336)
  })

  it('adds the navigation bar back on Android, whose IME height stops above it', () => {
    // The session dock is the proof this split is real: it pads itself by the inset and then
    // translates by the raw height, which lands on the keys only if Android's excludes the bar.
    expect(
      softwareKeyboardWindowInset({ keyboardHeight: 336, bottomInset: 48, platform: 'android' })
    ).toBe(384)
  })

  it('takes the page host as a phone, since it is one: the shell runs no web build', () => {
    expect(
      softwareKeyboardWindowInset({ keyboardHeight: 300, bottomInset: 20, platform: 'web' })
    ).toBe(320)
  })

  it('never reports a negative strip, whatever the event and the inset say', () => {
    expect(
      softwareKeyboardWindowInset({ keyboardHeight: -10, bottomInset: 48, platform: 'android' })
    ).toBe(0)
    expect(
      softwareKeyboardWindowInset({ keyboardHeight: 336, bottomInset: -48, platform: 'android' })
    ).toBe(336)
  })
})
