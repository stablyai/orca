import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalWebView } from './TerminalWebView'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: {
    absoluteFillObject: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0
    },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef((props: Record<string, unknown>, _ref) =>
    React.createElement('WebView', props)
  )
  return { WebView, default: WebView }
})

vi.mock('lucide-react-native', () => ({
  RefreshCw: 'RefreshCw'
}))

let renderer: ReactTestRenderer | null = null

function postWebViewMessage(payload: Record<string, unknown>): void {
  if (!renderer) {
    throw new Error('TerminalWebView did not render')
  }
  const webView = renderer.root.findByType('WebView')
  act(() => {
    webView.props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })
  })
}

describe('TerminalWebView query reply routing', () => {
  afterEach(() => {
    if (renderer) {
      act(() => renderer?.unmount())
      renderer = null
    }
    vi.restoreAllMocks()
  })

  it('routes only complete terminal query replies to native', () => {
    const onTerminalQueryReply = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => {
      renderer = create(createElement(TerminalWebView, { onTerminalQueryReply }))
    })

    postWebViewMessage({ type: 'terminal-data', bytes: '\x1b[3;4R' })
    postWebViewMessage({ type: 'terminal-data', bytes: 'a' })
    postWebViewMessage({ type: 'terminal-data', bytes: '\x1b[A' })

    expect(onTerminalQueryReply).toHaveBeenCalledTimes(1)
    expect(onTerminalQueryReply).toHaveBeenCalledWith('\x1b[3;4R')
  })
})
