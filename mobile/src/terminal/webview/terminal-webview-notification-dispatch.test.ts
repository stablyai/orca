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
})
