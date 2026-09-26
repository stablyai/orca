import { describe, expect, it } from 'vitest'

import {
  parseTerminalKeyboardAvoidanceMetrics,
  sameTerminalKeyboardAvoidanceMetrics,
  type TerminalKeyboardAvoidanceMetrics
} from './terminal-webview-contract'

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

describe('sameTerminalKeyboardAvoidanceMetrics', () => {
  const metrics: Required<TerminalKeyboardAvoidanceMetrics> = {
    cursorY: 38,
    contentBottomRow: 38,
    rows: 40,
    altScreen: false,
    rowPitch: 15
  }
  // One variant per field, each differing from `metrics` in that field alone.
  const variants: [keyof typeof metrics, TerminalKeyboardAvoidanceMetrics][] = [
    ['cursorY', { ...metrics, cursorY: 39 }],
    ['contentBottomRow', { ...metrics, contentBottomRow: 39 }],
    ['rows', { ...metrics, rows: 41 }],
    ['altScreen', { ...metrics, altScreen: true }],
    // Desktop display mode, measured on the page: same rows, the fit scale moved to 0.46.
    ['rowPitch', { ...metrics, rowPitch: 6.96 }]
  ]

  it('tells apart metrics that differ in any one field', () => {
    expect(sameTerminalKeyboardAvoidanceMetrics(metrics, { ...metrics })).toBe(true)
    expect(variants.map(([key]) => key).sort()).toEqual(Object.keys(metrics).sort())
    for (const [key, variant] of variants) {
      expect(sameTerminalKeyboardAvoidanceMetrics(metrics, variant), key).toBe(false)
    }
    const { rowPitch: _rowPitch, ...older } = metrics
    expect(sameTerminalKeyboardAvoidanceMetrics(metrics, older)).toBe(false)
  })
})
