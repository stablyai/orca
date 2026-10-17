import { describe, expect, it, vi } from 'vitest'

import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'

describe('dispatchTerminalWebViewNotification', () => {
  it('passes the selection geometry the copy cleanup needs', () => {
    const onSelectionCopy = vi.fn()
    const handlers = { onSelectionCopy, reportEngineError: vi.fn() }
    dispatchTerminalWebViewNotification(
      { type: 'selection', text: 'abc', startCol: 4, cols: 60 },
      handlers
    )
    expect(onSelectionCopy).toHaveBeenLastCalledWith('abc', { startCol: 4, cols: 60 })
  })

  it('copies without geometry when an older WebView or a bad width sends none', () => {
    const onSelectionCopy = vi.fn()
    const handlers = { onSelectionCopy, reportEngineError: vi.fn() }
    dispatchTerminalWebViewNotification({ type: 'selection', text: 'abc' }, handlers)
    expect(onSelectionCopy).toHaveBeenLastCalledWith('abc', undefined)
    dispatchTerminalWebViewNotification(
      { type: 'selection', text: 'abc', startCol: 0, cols: 0 },
      handlers
    )
    expect(onSelectionCopy).toHaveBeenLastCalledWith('abc', undefined)
  })

  it('preserves bounded keyboard metrics through the dispatcher', () => {
    const onKeyboardAvoidanceMetrics = vi.fn()
    dispatchTerminalWebViewNotification(
      {
        type: 'keyboard-avoidance-metrics',
        cursorY: 30,
        contentBottomRow: 99,
        rows: 40,
        altScreen: true
      },
      { onKeyboardAvoidanceMetrics, reportEngineError: vi.fn() }
    )
    expect(onKeyboardAvoidanceMetrics).toHaveBeenCalledWith({
      cursorY: 30,
      contentBottomRow: 39,
      rows: 40,
      altScreen: true
    })
  })

  it('keeps old WebView payloads cursor-compatible', () => {
    const onKeyboardAvoidanceMetrics = vi.fn()
    dispatchTerminalWebViewNotification(
      { type: 'keyboard-avoidance-metrics', cursorY: 12, rows: 40 },
      { onKeyboardAvoidanceMetrics, reportEngineError: vi.fn() }
    )
    expect(onKeyboardAvoidanceMetrics).toHaveBeenCalledWith({
      cursorY: 12,
      contentBottomRow: 12,
      rows: 40,
      altScreen: false
    })
  })
})
