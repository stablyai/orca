import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalWebView } from './TerminalWebView'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Pressable: 'Pressable',
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

vi.mock('react-native-webview', () => ({
  WebView: 'WebView',
  default: 'WebView'
}))

vi.mock('lucide-react-native', () => ({
  RefreshCw: 'RefreshCw'
}))

function suppressReactTestRendererDeprecationWarning(): () => void {
  const originalConsoleError = console.error
  const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation((...args) => {
    const firstArg = args[0]
    if (typeof firstArg === 'string' && firstArg.includes('react-test-renderer is deprecated')) {
      return
    }
    originalConsoleError(...args)
  })
  return () => consoleErrorSpy.mockRestore()
}

// Why: mounting TerminalWebView arms the web-ready watchdog; tests must
// unmount so the timer can't survive into later tests and fire in teardown.
let activeRenderer: ReactTestRenderer | null = null

function createTerminalWebViewRenderer(onEngineError = vi.fn()) {
  let renderer: ReactTestRenderer | null = null
  const restoreConsoleError = suppressReactTestRendererDeprecationWarning()
  try {
    act(() => {
      renderer = create(createElement(TerminalWebView, { onEngineError }))
    })
  } finally {
    restoreConsoleError()
  }
  if (!renderer) {
    throw new Error('TerminalWebView did not render')
  }
  activeRenderer = renderer
  return { onEngineError, renderer }
}

function postWebViewMessage(renderer: ReactTestRenderer, payload: Record<string, unknown>) {
  const webView = renderer.root.findByType('WebView')
  act(() => {
    webView.props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })
  })
}

function renderedText(renderer: ReactTestRenderer): string {
  return renderer.root
    .findAllByType('Text')
    .flatMap((node) => node.props.children)
    .join(' ')
}

describe('TerminalWebView engine errors', () => {
  afterEach(() => {
    if (activeRenderer) {
      act(() => {
        activeRenderer?.unmount()
      })
      activeRenderer = null
    }
    vi.restoreAllMocks()
  })

  it('renders the reload overlay for fatal engine errors from the WebView', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { onEngineError, renderer } = createTerminalWebViewRenderer()

    postWebViewMessage(renderer, {
      fatal: true,
      message: 'terminal engine missing - SyntaxError - Chrome 74',
      type: 'error'
    })

    expect(onEngineError).toHaveBeenCalledWith('terminal engine missing - SyntaxError - Chrome 74')
    expect(renderedText(renderer)).toContain('Terminal failed to load')
    expect(renderedText(renderer)).toContain('terminal engine missing - SyntaxError - Chrome 74')
    expect(renderedText(renderer)).toContain('Reload')
  })

  it('reports non-fatal engine errors without covering a live terminal', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { onEngineError, renderer } = createTerminalWebViewRenderer()

    postWebViewMessage(renderer, {
      fatal: false,
      message: 'terminal message failed - malformed chunk',
      type: 'error'
    })

    expect(onEngineError).toHaveBeenCalledWith('terminal message failed - malformed chunk')
    expect(renderedText(renderer)).not.toContain('Terminal failed to load')
  })

  it('keeps the first fatal diagnostics when later fatal reports cascade', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { renderer } = createTerminalWebViewRenderer()

    postWebViewMessage(renderer, {
      fatal: true,
      message: 'terminal engine missing - root cause',
      type: 'error'
    })
    postWebViewMessage(renderer, {
      fatal: true,
      message: 'Terminal did not initialize - watchdog cascade',
      type: 'error'
    })

    expect(renderedText(renderer)).toContain('terminal engine missing - root cause')
    expect(renderedText(renderer)).not.toContain('watchdog cascade')
  })

  // Why: if the document dies before the glue can post anything (or the RN
  // bridge never comes up), no message and no native error handler fires —
  // the watchdog must convert that silence into the visible fatal overlay.
  it('paints the fatal overlay when web-ready never arrives', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { onEngineError, renderer } = createTerminalWebViewRenderer()

      act(() => {
        vi.advanceTimersByTime(15000)
      })

      expect(onEngineError).toHaveBeenCalledWith(
        'Terminal did not initialize - no ready signal from the terminal view'
      )
      expect(renderedText(renderer)).toContain('Terminal failed to load')
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not fire the watchdog once web-ready has arrived', () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { onEngineError, renderer } = createTerminalWebViewRenderer()

      postWebViewMessage(renderer, { type: 'web-ready' })
      act(() => {
        vi.advanceTimersByTime(60000)
      })

      expect(onEngineError).not.toHaveBeenCalled()
      expect(renderedText(renderer)).not.toContain('Terminal failed to load')
    } finally {
      vi.useRealTimers()
    }
  })
})
