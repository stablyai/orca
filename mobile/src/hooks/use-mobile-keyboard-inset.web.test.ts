// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import { measureMobileWebKeyboardInset } from './use-mobile-keyboard-inset.web'

describe('mobile web keyboard inset', () => {
  it('measures the viewport region obscured by the software keyboard', () => {
    expect(measureMobileWebKeyboardInset(844, { height: 510, offsetTop: 47 })).toBe(287)
    expect(measureMobileWebKeyboardInset(844, { height: 844, offsetTop: 0 })).toBe(0)
  })

  it('clamps oversize and unavailable viewports', () => {
    expect(measureMobileWebKeyboardInset(600, { height: 650, offsetTop: 0 })).toBe(0)
    expect(measureMobileWebKeyboardInset(600, null)).toBe(0)
  })
})
