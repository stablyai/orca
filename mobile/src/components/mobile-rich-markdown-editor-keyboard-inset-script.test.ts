import { describe, expect, it } from 'vitest'
import { normalizeMobileRichMarkdownKeyboardInset } from './mobile-rich-markdown-editor-keyboard-inset-script'

describe('normalizeMobileRichMarkdownKeyboardInset', () => {
  it('rounds finite inset measurements for native layout', () => {
    expect(normalizeMobileRichMarkdownKeyboardInset(42.6)).toBe(43)
  })

  it('clamps negative inset measurements to zero', () => {
    expect(normalizeMobileRichMarkdownKeyboardInset(-8)).toBe(0)
  })

  it('rejects non-finite inset measurements', () => {
    expect(normalizeMobileRichMarkdownKeyboardInset(Number.NaN)).toBeNull()
    expect(normalizeMobileRichMarkdownKeyboardInset(Number.POSITIVE_INFINITY)).toBeNull()
  })
})
