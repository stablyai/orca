import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyMobileColorScheme, paletteForScheme } from '../theme/mobile-theme'
import {
  MOBILE_DARK_TERMINAL_THEME,
  MOBILE_LIGHT_TERMINAL_THEME,
  getMobileViewerColorQueryReplies,
  isLightTerminalBackground,
  resolveEffectiveMobileTerminalTheme
} from './resolve-mobile-terminal-theme'
import { createTerminalDocumentScope } from './document/document-scope'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import { TERMINAL_DOCUMENT_ELEMENT_STYLE, xtermWebViewSource } from './terminal-webview-html'
import { TerminalWebView } from './TerminalWebView'

const nativeWebViewMethods = vi.hoisted(() => ({
  postMessage: vi.fn<(message: string) => void>(),
  reload: vi.fn<() => void>()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  StyleSheet: {
    absoluteFillObject: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => nativeWebViewMethods)
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('lucide-react-native', () => ({
  RefreshCw: 'RefreshCw'
}))

let activeRenderer: ReactTestRenderer | null = null

afterEach(() => {
  if (activeRenderer) {
    act(() => activeRenderer?.unmount())
    activeRenderer = null
  }
  nativeWebViewMethods.postMessage.mockClear()
  applyMobileColorScheme('dark')
})

describe('mobile terminal light/dark theme enforcement', () => {
  it('classifies hex and rgb background brightness accurately', () => {
    expect(isLightTerminalBackground('#ffffff')).toBe(true)
    expect(isLightTerminalBackground('#f5f5f5')).toBe(true)
    expect(isLightTerminalBackground('rgba(250, 250, 250, 0.9)')).toBe(true)
    expect(isLightTerminalBackground('#1a1b26')).toBe(false)
    expect(isLightTerminalBackground('#282c34')).toBe(false)
    expect(isLightTerminalBackground('rgb(26, 27, 38)')).toBe(false)
    expect(isLightTerminalBackground(undefined)).toBeNull()
  })

  it('enforces built-in light palette when mobile is light even if desktop sends dark or dark-in-light palette', () => {
    const desktopDark = {
      mode: 'dark' as const,
      theme: { ...MOBILE_DARK_TERMINAL_THEME, background: '#282c34' },
      minimumContrastRatio: 4.5
    }
    const resolvedFromDark = resolveEffectiveMobileTerminalTheme(desktopDark, 'light')
    expect(resolvedFromDark.mode).toBe('light')
    expect(resolvedFromDark.theme.background).toBe(MOBILE_LIGHT_TERMINAL_THEME.background)
    expect(resolvedFromDark.minimumContrastRatio).toBe(4.5)

    // Desktop with terminalUseSeparateLightTheme=false sends mode='light' with dark background
    const desktopDarkInLight = {
      mode: 'light' as const,
      theme: { ...MOBILE_DARK_TERMINAL_THEME, background: '#282c34' },
      minimumContrastRatio: 3
    }
    const resolvedFromDarkInLight = resolveEffectiveMobileTerminalTheme(desktopDarkInLight, 'light')
    expect(resolvedFromDarkInLight.mode).toBe('light')
    expect(resolvedFromDarkInLight.theme.background).toBe('#ffffff')
    expect(resolvedFromDarkInLight.minimumContrastRatio).toBe(3)
  })

  it('preserves custom host light or dark palettes when polarity matches mobile colorScheme', () => {
    const customLight = {
      mode: 'light' as const,
      theme: { ...MOBILE_LIGHT_TERMINAL_THEME, background: '#fdf6e3', foreground: '#586e75' },
      minimumContrastRatio: 4
    }
    expect(resolveEffectiveMobileTerminalTheme(customLight, 'light')).toBe(customLight)
    expect(resolveEffectiveMobileTerminalTheme(customLight, 'dark')).toMatchObject({
      mode: 'dark',
      theme: { background: MOBILE_DARK_TERMINAL_THEME.background },
      minimumContrastRatio: 4
    })
  })

  it('dynamically updates TerminalWebView set-theme and frame background when applyMobileColorScheme toggles light <-> dark', () => {
    expect(paletteForScheme('light').terminalBg).toBe('#ffffff')
    expect(paletteForScheme('dark').terminalBg).toBe('#1a1b26')

    const desktopDarkTheme = {
      mode: 'dark' as const,
      theme: { ...MOBILE_DARK_TERMINAL_THEME, background: '#1a1b26' }
    }

    act(() => {
      activeRenderer = create(createElement(TerminalWebView, { terminalTheme: desktopDarkTheme }))
    })

    const webViewNode = activeRenderer!.root.findByType('WebView' as never)
    act(() => {
      ;(webViewNode.props.onMessage as (ev: unknown) => void)({
        nativeEvent: { data: JSON.stringify({ type: 'web-ready' }) }
      })
    })
    nativeWebViewMethods.postMessage.mockClear()

    act(() => {
      applyMobileColorScheme('light')
    })

    expect(TERMINAL_WEBVIEW_FRAME_STYLES.container.backgroundColor).toBe('#ffffff')
    const posted = nativeWebViewMethods.postMessage.mock.calls.map(([raw]) => JSON.parse(raw))
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'set-theme',
        terminalTheme: expect.objectContaining({
          mode: 'light',
          theme: expect.objectContaining({ background: '#ffffff' })
        })
      })
    )
  })

  it('seeds light initial theme in WebView HTML, document body, and provisional document scope', () => {
    expect(getMobileViewerColorQueryReplies('light')).toEqual({
      foreground: MOBILE_LIGHT_TERMINAL_THEME.foreground,
      background: '#ffffff'
    })
    expect(getMobileViewerColorQueryReplies('dark')).toEqual({
      foreground: MOBILE_DARK_TERMINAL_THEME.foreground,
      background: '#1a1b26'
    })

    const source = xtermWebViewSource({
      textScale: 1,
      shown: true,
      backgroundColor: '#ffffff',
      foregroundColor: '#2e3434'
    })
    expect(source.html).toContain('document.documentElement.style.background = "#ffffff"')
    expect(source.html).toContain('document.body.style.background = "#ffffff"')
    expect(source.html).toContain('window.__orcaTerminalInitialBg = "#ffffff"')
    expect(source.html).toContain('window.__orcaTerminalInitialFg = "#2e3434"')
    expect(TERMINAL_DOCUMENT_ELEMENT_STYLE).toContain('background-color: transparent !important')

    const scope = createTerminalDocumentScope({
      start: () => ({
        textScale: 1,
        shown: true,
        backgroundColor: '#ffffff',
        foregroundColor: '#2e3434'
      })
    })
    expect(scope.defaultTheme.background).toBe('#ffffff')
    expect(scope.terminalTheme.background).toBe('#ffffff')
    expect(scope.terminalTheme.foreground).toBe('#2e3434')
  })
})
