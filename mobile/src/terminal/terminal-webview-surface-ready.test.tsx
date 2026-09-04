import { createElement, forwardRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalWebViewHandle } from './terminal-webview-contract'

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn(),
  reload: vi.fn(),
  platformOS: { value: 'ios' }
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
  Platform: {
    get OS() {
      return mocks.platformOS.value
    }
  },
  View: 'View',
  StyleSheet: { create: <T,>(styles: T) => styles, absoluteFillObject: {} },
  Text: 'Text',
  Pressable: 'Pressable'
}))

vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))

vi.mock('react-native-webview', () => ({
  WebView: forwardRef(function MockWebView(props: Record<string, unknown>, ref) {
    if (ref && typeof ref === 'object') {
      ;(ref as { current: unknown }).current = { postMessage: mocks.postMessage, reload: mocks.reload }
    }
    return createElement('WebView', props)
  })
}))

// Why: the real source inlines the generated xterm bundle, which is not built in unit tests.
vi.mock('./terminal-webview-html', () => ({ XTERM_WEBVIEW_SOURCE: { html: '<html></html>' } }))

import { TerminalWebView } from './TerminalWebView'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'
import { TerminalWebViewEngineErrorOverlay } from './terminal-webview-engine-error-state'

function findWebView(renderer: ReactTestRenderer) {
  return renderer.root.findByType('WebView' as never)
}

function webViewIsHidden(renderer: ReactTestRenderer): boolean {
  const style = findWebView(renderer).props.style as unknown[]
  return Array.isArray(style) && style.includes(TERMINAL_WEBVIEW_FRAME_STYLES.webviewHidden)
}

function deliverMessage(renderer: ReactTestRenderer, payload: Record<string, unknown>): void {
  act(() => {
    findWebView(renderer).props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })
  })
}

describe('TerminalWebView surface readiness gate', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  function render(): { renderer: ReactTestRenderer; ref: { current: TerminalWebViewHandle | null } } {
    const ref = { current: null as TerminalWebViewHandle | null }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(TerminalWebView, { ref } as never))
    })
    return { renderer, ref }
  }

  it('hides the surface through web-ready and reveals only on the painted ready', () => {
    const { renderer } = render()
    expect(webViewIsHidden(renderer)).toBe(true)

    // Why: web-ready proves script liveness, not a committed repaint — still hidden.
    deliverMessage(renderer, { type: 'web-ready' })
    expect(webViewIsHidden(renderer)).toBe(true)

    deliverMessage(renderer, { type: 'ready' })
    expect(webViewIsHidden(renderer)).toBe(false)
  })

  it('hides again on load start and stays hidden through the recovery pong until ready', () => {
    const { renderer, ref } = render()
    deliverMessage(renderer, { type: 'web-ready' })
    deliverMessage(renderer, { type: 'ready' })
    expect(webViewIsHidden(renderer)).toBe(false)

    act(() => {
      findWebView(renderer).props.onLoadStart()
    })
    expect(webViewIsHidden(renderer)).toBe(true)

    deliverMessage(renderer, { type: 'web-ready' })
    act(() => {
      ref.current?.prepareForForegroundRecovery()
    })
    expect(webViewIsHidden(renderer)).toBe(true)

    const pingId = JSON.parse(mocks.postMessage.mock.calls.at(-1)?.[0] as string).id as number
    deliverMessage(renderer, { type: 'pong', pingId })
    // Why: the pong restores messaging, but only the re-init 'ready' proves a repaint.
    expect(webViewIsHidden(renderer)).toBe(true)

    deliverMessage(renderer, { type: 'ready' })
    expect(webViewIsHidden(renderer)).toBe(false)
  })

  function lastPostedPingId(): number {
    const pings = mocks.postMessage.mock.calls
      .map((c) => JSON.parse(c[0] as string) as { type: string; id: number })
      .filter((m) => m.type === 'ping')
    expect(pings.length).toBeGreaterThan(0)
    return pings.at(-1)!.id
  }

  it('watchdog pings the live document before surfacing the engine error', () => {
    vi.useFakeTimers()
    const onWebReady = vi.fn()
    const onEngineError = vi.fn()
    const ref = { current: null as TerminalWebViewHandle | null }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(TerminalWebView, { ref, onWebReady, onEngineError } as never))
    })

    act(() => {
      vi.advanceTimersByTime(15000)
    })
    // Why: the probe replaces the immediate error — a ping goes out instead.
    expect(onEngineError).not.toHaveBeenCalled()
    const pingId = lastPostedPingId()

    deliverMessage(renderer, { type: 'pong', pingId })
    // Why: the probe's pong must notify the parent so it resubscribes and re-inits.
    expect(onWebReady).toHaveBeenCalledTimes(1)
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(onEngineError).not.toHaveBeenCalled()
  })

  it('watchdog still errors when the probe goes unanswered', () => {
    vi.useFakeTimers()
    const onEngineError = vi.fn()
    act(() => {
      create(createElement(TerminalWebView, { onEngineError } as never))
    })
    act(() => {
      vi.advanceTimersByTime(15000)
    })
    expect(onEngineError).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(onEngineError).toHaveBeenCalled()
  })

  it('reload button pings first and only reloads when the probe expires', () => {
    vi.useFakeTimers()
    const onEngineError = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(TerminalWebView, { onEngineError } as never))
    })
    act(() => {
      vi.advanceTimersByTime(15000 + 2500)
    })
    expect(onEngineError).toHaveBeenCalled()

    const overlay = renderer.root.findByType(TerminalWebViewEngineErrorOverlay)
    act(() => {
      overlay.props.onReload()
    })
    expect(mocks.reload).not.toHaveBeenCalled()
    const pingId = lastPostedPingId()

    deliverMessage(renderer, { type: 'pong', pingId })
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    // Why: the live document answered — reload never fires.
    expect(mocks.reload).not.toHaveBeenCalled()
  })

  it('reload button falls back to a real reload when the document stays silent', () => {
    vi.useFakeTimers()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(TerminalWebView, {} as never))
    })
    act(() => {
      vi.advanceTimersByTime(15000 + 2500)
    })
    const overlay = renderer.root.findByType(TerminalWebViewEngineErrorOverlay)
    act(() => {
      overlay.props.onReload()
    })
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    expect(mocks.reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the surface visible on non-iOS foreground recovery', () => {
    mocks.platformOS.value = 'android'
    try {
      const { renderer, ref } = render()
      deliverMessage(renderer, { type: 'web-ready' })
      deliverMessage(renderer, { type: 'ready' })
      act(() => {
        ref.current?.prepareForForegroundRecovery()
      })
      expect(webViewIsHidden(renderer)).toBe(false)
    } finally {
      mocks.platformOS.value = 'ios'
    }
  })
})
