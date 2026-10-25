import { describe, expect, it, vi } from 'vitest'

import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'

describe('dispatchTerminalWebViewNotification', () => {
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

  it('routes a swipe down to its own handler, apart from taps', () => {
    const onTerminalSwipeDown = vi.fn()
    const onTerminalTap = vi.fn()
    dispatchTerminalWebViewNotification(
      { type: 'terminal-swipe-down' },
      { onTerminalSwipeDown, onTerminalTap, reportEngineError: vi.fn() }
    )
    expect(onTerminalSwipeDown).toHaveBeenCalledTimes(1)
    expect(onTerminalTap).not.toHaveBeenCalled()
  })

  it('passes a tap click on and keeps other terminal input bytes-only', () => {
    const onTerminalInput = vi.fn()
    const handlers = { onTerminalInput, reportEngineError: vi.fn() }
    const click = '\x1b[<0;9;31M\x1b[<0;9;31m'
    const wheel = '\x1b[<64;9;31M'
    dispatchTerminalWebViewNotification(
      { type: 'terminal-input', bytes: click, click: true },
      handlers
    )
    dispatchTerminalWebViewNotification({ type: 'terminal-input', bytes: wheel }, handlers)
    expect(onTerminalInput.mock.calls).toEqual([[click, { click: true }], [wheel]])
  })
})
