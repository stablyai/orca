import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { getBuiltinTerminalThemePalette } from '../../../src/shared/terminal-themes'
import type { MobileTerminalTheme } from '../terminal/terminal-webview-contract'

const { terminalWebViewRender } = vi.hoisted(() => ({ terminalWebViewRender: vi.fn() }))

vi.mock('react-native', () => ({
  StyleSheet: { create: <T>(styles: T) => styles, absoluteFillObject: {} },
  View: 'View'
}))

vi.mock('../terminal/TerminalWebView', () => ({
  TerminalWebView: (props: unknown) => {
    terminalWebViewRender(props)
    return null
  }
}))

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined)
  }
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

const hostTheme: MobileTerminalTheme = {
  mode: 'dark',
  theme: { background: '#101010', foreground: '#f0f0f0' }
}

function lastTerminalThemeProp(): MobileTerminalTheme | undefined {
  const props = terminalWebViewRender.mock.calls.at(-1)?.[0] as {
    terminalTheme?: MobileTerminalTheme
  }
  return props.terminalTheme
}

describe('TerminalPaneView', () => {
  afterAll(() => {
    restoreConsoleError()
  })

  it('hands the WebView the device-resolved terminal theme, not the host-pushed one', async () => {
    vi.resetModules()
    const { saveMobileTerminalThemeSelection } =
      await import('../storage/terminal-theme-preference')
    const { TerminalPaneView } = await import('./TerminalPaneView')

    const noop = () => undefined
    let renderer!: ReactTestRenderer
    await act(async () => {
      renderer = create(
        createElement(TerminalPaneView, {
          handle: 'terminal-a',
          active: true,
          keyboardLift: 0,
          terminalTheme: hostTheme,
          textScale: 1,
          onRef: noop,
          onWebReady: noop,
          onSelectionMode: noop,
          onSelectionCopy: noop,
          onSelectionEvicted: noop,
          onModesChanged: noop,
          onKeyboardAvoidanceMetrics: noop,
          onHaptic: noop,
          onTerminalInput: noop,
          onTerminalQueryReply: noop,
          onTerminalTap: noop,
          onFileTap: noop,
          onOpenUrl: noop,
          onTextScaleChange: noop
        })
      )
    })

    expect(lastTerminalThemeProp()).toBe(hostTheme)

    await act(async () => {
      await saveMobileTerminalThemeSelection({ dark: 'One Dark' })
    })

    expect(lastTerminalThemeProp()).toEqual({
      mode: 'dark',
      theme: getBuiltinTerminalThemePalette('One Dark')
    })

    await act(async () => {
      renderer.unmount()
    })
  })
})
