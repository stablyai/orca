import { describe, expect, it } from 'vitest'

import {
  parseTerminalKeyboardAvoidanceMetrics,
  type TerminalWebViewHandle
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
})

describe('TerminalWebViewHandle viewport contract', () => {
  it('accepts measured width and forwards explicit viewport bounds', async () => {
    const viewportMethods = {
      measureFitDimensions: async (height?: number, width?: number) =>
        height && width ? { cols: width, rows: height } : null,
      setViewport: (_width: number, _height: number) => {}
    } satisfies Pick<TerminalWebViewHandle, 'measureFitDimensions' | 'setViewport'>

    await expect(viewportMethods.measureFitDimensions(600, 800)).resolves.toEqual({
      cols: 800,
      rows: 600
    })
    expect(() => viewportMethods.setViewport(800, 600)).not.toThrow()
  })
})
