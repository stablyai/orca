import { describe, expect, it } from 'vitest'

import { parseTerminalKeyboardAvoidanceMetrics } from './terminal-webview-contract'

describe('parseTerminalKeyboardAvoidanceMetrics', () => {
  it('defaults contentBottomRow to cursorY when absent (older WebView bundles)', () => {
    expect(parseTerminalKeyboardAvoidanceMetrics({ cursorY: 12, rows: 40 })).toEqual({
      cursorY: 12,
      contentBottomRow: 12,
      rows: 40,
      altScreen: false
    })
  })

  it('bounds untrusted numeric fields to the reported viewport', () => {
    expect(
      parseTerminalKeyboardAvoidanceMetrics({
        cursorY: Number.POSITIVE_INFINITY,
        contentBottomRow: 99.8,
        rows: 40.7,
        altScreen: 'true'
      })
    ).toEqual({ cursorY: 0, contentBottomRow: 39, rows: 40, altScreen: false })
    expect(
      parseTerminalKeyboardAvoidanceMetrics({
        cursorY: -4,
        contentBottomRow: Number.NaN,
        rows: -1
      })
    ).toEqual({ cursorY: 0, contentBottomRow: 0, rows: 0, altScreen: false })
  })

  it('carries the drawn row pitch when the document reports one, and omits it otherwise', () => {
    expect(parseTerminalKeyboardAvoidanceMetrics({ cursorY: 46, rows: 47, rowPitch: 7.5 })).toEqual(
      { cursorY: 46, contentBottomRow: 46, rows: 47, altScreen: false, rowPitch: 7.5 }
    )
    for (const rowPitch of [undefined, 0, -3, Number.NaN, Number.POSITIVE_INFINITY, '15']) {
      expect(
        'rowPitch' in parseTerminalKeyboardAvoidanceMetrics({ cursorY: 1, rows: 4, rowPitch })
      ).toBe(false)
    }
  })
})
