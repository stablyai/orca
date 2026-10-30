import { describe, expect, it } from 'vitest'
import { resolveBottomDrawerFillHeight } from './bottom-drawer-fill-height'

describe('resolveBottomDrawerFillHeight', () => {
  it('fills the space under the safe top when the keyboard is closed', () => {
    expect(
      resolveBottomDrawerFillHeight({
        screenHeight: 844,
        topInset: 54,
        keyboardInset: 0,
        topGap: 16
      })
    ).toBe(844 - 54 - 16)
  })

  it('shrinks by the keyboard inset so the sheet top stays under the status bar', () => {
    expect(
      resolveBottomDrawerFillHeight({
        screenHeight: 844,
        topInset: 54,
        keyboardInset: 292,
        topGap: 16
      })
    ).toBe(844 - 54 - 16 - 292)
  })

  it('never expands past the space above the keyboard on tiny viewports', () => {
    expect(
      resolveBottomDrawerFillHeight({
        screenHeight: 400,
        topInset: 50,
        keyboardInset: 300,
        topGap: 16
      })
    ).toBe(34)
  })
})
