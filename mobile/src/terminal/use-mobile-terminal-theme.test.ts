import { createElement, Fragment, type ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_TERMINAL_THEMES } from '../../../src/shared/terminal-default-themes'
import { TerminalPaneView } from '../session/TerminalPaneView'
import type { MobileTerminalTheme } from './terminal-webview-contract'

const state = vi.hoisted(() => ({
  scheme: 'dark' as 'dark' | 'light' | null,
  mode: 'system' as 'system' | 'dark' | 'light' | 'desktop',
  schemeListeners: new Set<() => void>(),
  modeListeners: new Set<() => void>(),
  load: vi.fn()
}))

vi.mock('react-native', async () => {
  const React = await import('react')
  return {
    StyleSheet: { absoluteFillObject: {}, create: (styles: unknown) => styles },
    View: 'View',
    useColorScheme: () =>
      React.useSyncExternalStore(
        (listener) => {
          state.schemeListeners.add(listener)
          return () => state.schemeListeners.delete(listener)
        },
        () => state.scheme
      )
  }
})

vi.mock('../storage/terminal-theme-preference', () => ({
  getMobileTerminalThemeMode: () => state.mode,
  loadMobileTerminalThemeMode: state.load,
  subscribeMobileTerminalThemeMode: (listener: () => void) => {
    state.modeListeners.add(listener)
    return () => state.modeListeners.delete(listener)
  }
}))

vi.mock('./TerminalWebView', () => ({ TerminalWebView: 'TerminalWebView' }))

const hostLight: MobileTerminalTheme = {
  mode: 'light',
  theme: { background: '#ffffff', foreground: '#111111' }
}

function paneProps(hostTheme = hostLight): ComponentProps<typeof TerminalPaneView> {
  const noop = () => undefined
  return {
    handle: 'pty-1',
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
    onTerminalPlainTap: noop,
    onTerminalPlainTapCancelled: noop,
    onFileTap: noop,
    onOpenUrl: noop,
    onTextScaleChange: noop
  }
}

describe('mobile terminal appearance on an existing pane', () => {
  let renderer: ReactTestRenderer | null = null

  beforeEach(() => {
    state.mode = 'system'
    state.scheme = 'dark'
    state.load.mockReset().mockResolvedValue('system')
  })

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.restoreAllMocks()
  })

  async function mount(): Promise<void> {
    await act(async () => {
      renderer = create(createElement(TerminalPaneView, paneProps()))
    })
  }

  function terminal() {
    return renderer!.root.findByType('TerminalWebView')
  }

  function setScheme(scheme: typeof state.scheme): void {
    act(() => {
      state.scheme = scheme
      state.schemeListeners.forEach((listener) => listener())
    })
  }

  function setMode(mode: typeof state.mode): void {
    act(() => {
      state.mode = mode
      state.modeListeners.forEach((listener) => listener())
    })
  }

  it('uses the phone appearance by default and repaints the same mounted WebView on OS changes', async () => {
    await mount()
    const mountedTerminal = terminal()
    expect(mountedTerminal.props.terminalTheme).toEqual({
      mode: 'dark',
      theme: DEFAULT_TERMINAL_THEMES['Ghostty Default Style Dark']
    })
    expect(mountedTerminal.props.style).toContainEqual({
      backgroundColor: DEFAULT_TERMINAL_THEMES['Ghostty Default Style Dark'].background
    })
    setScheme('light')
    expect(terminal()).toBe(mountedTerminal)
    expect(terminal().props.terminalTheme).toEqual({
      mode: 'light',
      theme: DEFAULT_TERMINAL_THEMES['Builtin Tango Light']
    })
    expect(mountedTerminal.props.style).toContainEqual({
      backgroundColor: DEFAULT_TERMINAL_THEMES['Builtin Tango Light'].background
    })
    setScheme(null)
    expect(terminal().props.terminalTheme.mode).toBe('dark')
  })

  it('keeps explicit dark and light modes independent of the phone appearance', async () => {
    await mount()
    setMode('light')
    expect(terminal().props.terminalTheme.mode).toBe('light')
    setScheme('light')
    setMode('dark')
    expect(terminal().props.terminalTheme.mode).toBe('dark')
    setScheme('dark')
    expect(terminal().props.terminalTheme.mode).toBe('dark')
  })

  it('updates inactive mounted panes along with the active pane', async () => {
    await act(async () => {
      renderer = create(
        createElement(
          Fragment,
          null,
          createElement(TerminalPaneView, { ...paneProps(), key: 'active' }),
          createElement(TerminalPaneView, {
            ...paneProps(),
            key: 'inactive',
            handle: 'pty-2',
            active: false
          })
        )
      )
    })
    const panes = renderer!.root.findAllByType('TerminalWebView')
    setScheme('light')
    expect(panes.map((pane) => pane.props.terminalTheme.mode)).toEqual(['light', 'light'])
    setMode('dark')
    expect(panes.map((pane) => pane.props.terminalTheme.mode)).toEqual(['dark', 'dark'])
    expect(renderer!.root.findAllByType('TerminalWebView')).toEqual(panes)
  })

  it('passes through the current host theme only in desktop mode', async () => {
    state.mode = 'desktop'
    await mount()
    const mountedTerminal = terminal()
    expect(mountedTerminal.props.terminalTheme).toBe(hostLight)
    const hostDark: MobileTerminalTheme = { mode: 'dark', theme: { background: '#242424' } }
    act(() => renderer!.update(createElement(TerminalPaneView, paneProps(hostDark))))
    expect(terminal()).toBe(mountedTerminal)
    expect(terminal().props.terminalTheme).toBe(hostDark)
    setScheme('light')
    expect(terminal().props.terminalTheme).toBe(hostDark)
    act(() =>
      renderer!.update(
        createElement(TerminalPaneView, { ...paneProps(), terminalTheme: undefined })
      )
    )
    expect(terminal().props.terminalTheme).toBeUndefined()
  })

  it('reports hydration failure while retaining the explicit system default', async () => {
    const error = new Error('storage unavailable')
    state.load.mockRejectedValue(error)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await mount()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminal appearance'), error)
    expect(terminal().props.terminalTheme.mode).toBe('dark')
  })
})
