import { describe, expect, it } from 'vitest'
import { resolveBottomDrawerKeyboardInset } from './bottom-drawer-keyboard-inset'

describe('resolveBottomDrawerKeyboardInset', () => {
  it('uses the full keyboard frame for fill sheets on iOS and Android', () => {
    expect(
      resolveBottomDrawerKeyboardInset({
        keyboardHeight: 336,
        bottomInset: 34,
        fillAvailable: true,
        platform: 'ios'
      })
    ).toBe(336)
    expect(
      resolveBottomDrawerKeyboardInset({
        keyboardHeight: 300,
        bottomInset: 48,
        fillAvailable: true,
        platform: 'android'
      })
    ).toBe(300)
  })

  it('subtracts the home-indicator inset only for iOS content-sized sheets', () => {
    expect(
      resolveBottomDrawerKeyboardInset({
        keyboardHeight: 336,
        bottomInset: 34,
        fillAvailable: false,
        platform: 'ios'
      })
    ).toBe(302)
  })

  it('uses the full IME height for Android content-sized sheets', () => {
    // Why: Android keyboard height does not include the nav bar (session terminal lift).
    expect(
      resolveBottomDrawerKeyboardInset({
        keyboardHeight: 300,
        bottomInset: 48,
        fillAvailable: false,
        platform: 'android'
      })
    ).toBe(300)
  })

  it('never returns a negative inset', () => {
    expect(
      resolveBottomDrawerKeyboardInset({
        keyboardHeight: 20,
        bottomInset: 34,
        fillAvailable: false,
        platform: 'ios'
      })
    ).toBe(0)
  })
})
