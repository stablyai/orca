import { describe, expect, it } from 'vitest'

import { parseTerminalKeyboardAvoidanceMetrics } from './terminal-webview-contract'

describe('parseTerminalKeyboardAvoidanceMetrics', () => {
  it('parses a full payload', () => {
    expect(
      parseTerminalKeyboardAvoidanceMetrics({
        cursorY: 30,
        contentBottomRow: 34,
        rows: 40,
        altScreen: true
      })
    ).toEqual({ cursorY: 30, contentBottomRow: 34, rows: 40, altScreen: true })
  })

  it('defaults contentBottomRow to cursorY when absent (older WebView bundles)', () => {
    expect(parseTerminalKeyboardAvoidanceMetrics({ cursorY: 12, rows: 40 })).toEqual({
      cursorY: 12,
      contentBottomRow: 12,
      rows: 40,
      altScreen: false
    })
  })

  it('defaults non-numeric fields to zero', () => {
    expect(parseTerminalKeyboardAvoidanceMetrics({})).toEqual({
      cursorY: 0,
      contentBottomRow: 0,
      rows: 0,
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
})
