import { describe, expect, it, vi } from 'vitest'

import { dispatchTerminalWebViewNotification } from './terminal-webview-notification-dispatch'

describe('dispatchTerminalWebViewNotification', () => {
  it('routes plain terminal taps separately from focus-only taps', () => {
    const onTerminalTap = vi.fn()
    const onTerminalPlainTap = vi.fn()
    const onTerminalPlainTapCancelled = vi.fn()

    dispatchTerminalWebViewNotification(
      { type: 'terminal-tap' },
      {
        onTerminalTap,
        onTerminalPlainTap,
        onTerminalPlainTapCancelled,
        reportEngineError: vi.fn()
      }
    )
    dispatchTerminalWebViewNotification(
      { type: 'terminal-plain-tap' },
      {
        onTerminalTap,
        onTerminalPlainTap,
        onTerminalPlainTapCancelled,
        reportEngineError: vi.fn()
      }
    )
    dispatchTerminalWebViewNotification(
      { type: 'terminal-plain-tap-cancelled' },
      {
        onTerminalTap,
        onTerminalPlainTap,
        onTerminalPlainTapCancelled,
        reportEngineError: vi.fn()
      }
    )

    expect(onTerminalTap).toHaveBeenCalledTimes(1)
    expect(onTerminalPlainTap).toHaveBeenCalledTimes(1)
    expect(onTerminalPlainTapCancelled).toHaveBeenCalledTimes(1)
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
