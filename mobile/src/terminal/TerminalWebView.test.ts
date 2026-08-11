import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { TerminalWebView } from './TerminalWebView'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import type { MobileTerminalTheme } from './terminal-webview-contract'

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  StyleSheet: { create: <T>(styles: T) => styles },
  View: 'View'
}))

vi.mock('react-native-webview', () => ({ WebView: 'WebView' }))

vi.mock('./terminal-webview-html', () => ({ XTERM_WEBVIEW_SOURCE: { html: '' } }))

vi.mock('./terminal-webview-engine-error-state', () => ({
  TerminalWebViewEngineErrorOverlay: 'TerminalWebViewEngineErrorOverlay',
  useTerminalWebViewEngineErrorState: () => ({
    clearEngineError: vi.fn(),
    engineError: null,
    reportEngineError: vi.fn(),
    reportNativeEngineError: vi.fn()
  })
}))

vi.mock('./terminal-webview-ready-watchdog', () => ({
  useTerminalWebReadyWatchdog: () => ({
    armWebReadyWatchdog: vi.fn(),
    clearWebReadyWatchdog: vi.fn()
  })
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

const restoreConsoleError = suppressReactTestRendererDeprecationWarning()

async function renderFrame(terminalTheme?: MobileTerminalTheme) {
  let renderer!: ReactTestRenderer
  await act(async () => {
    renderer = create(createElement(TerminalWebView, { terminalTheme }))
  })
  const container = renderer.root.findByType('View' as never)
  const webView = renderer.root.findByType('WebView' as never)
  return {
    containerStyle: container.props.style as unknown[],
    webViewStyle: webView.props.style as unknown[],
    unmount: async () => {
      await act(async () => {
        renderer.unmount()
      })
    }
  }
}

describe('TerminalWebView frame background', () => {
  afterAll(() => {
    restoreConsoleError()
  })

  it('keeps the app terminal background until a palette arrives', async () => {
    const frame = await renderFrame(undefined)

    expect(frame.containerStyle[0]).toBe(TERMINAL_WEBVIEW_FRAME_STYLES.container)
    expect(frame.containerStyle[1]).toBeNull()
    expect(frame.webViewStyle[0]).toBe(TERMINAL_WEBVIEW_FRAME_STYLES.webview)
    expect(frame.webViewStyle[1]).toBeNull()

    await frame.unmount()
  })

  // Why: `terminalTheme` is unvalidated wire data, so a version-mismatched host may push no palette.
  it('falls back to the app terminal background when the host pushes no palette object', async () => {
    const frame = await renderFrame({ mode: 'dark' } as unknown as MobileTerminalTheme)

    expect(frame.containerStyle[1]).toBeNull()
    expect(frame.webViewStyle[1]).toBeNull()

    await frame.unmount()
  })

  it('paints the frame with the resolved terminal background so a light theme has no dark halo', async () => {
    const frame = await renderFrame({
      mode: 'light',
      theme: { background: '#ffffff', foreground: '#24292e' }
    })

    expect(frame.containerStyle[1]).toEqual({ backgroundColor: '#ffffff' })
    expect(frame.webViewStyle[1]).toEqual({ backgroundColor: '#ffffff' })

    await frame.unmount()
  })
})
