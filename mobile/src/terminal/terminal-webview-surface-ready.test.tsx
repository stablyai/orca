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
      ;(ref as { current: unknown }).current = {
        postMessage: mocks.postMessage,
        reload: mocks.reload
      }
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

  function render(): {
    renderer: ReactTestRenderer
    ref: { current: TerminalWebViewHandle | null }
  } {
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

    deliverMessage(renderer, { type: 'ready', source: 'init' })
    expect(webViewIsHidden(renderer)).toBe(false)
  })

  it('hides again on load start and stays hidden through the recovery pong until ready', () => {
    const { renderer, ref } = render()
    deliverMessage(renderer, { type: 'web-ready' })
    deliverMessage(renderer, { type: 'ready', source: 'init' })
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

    deliverMessage(renderer, { type: 'ready', source: 'init' })
    expect(webViewIsHidden(renderer)).toBe(false)
  })

  it('stays hidden when a resize answers before the recovery re-init', () => {
    const { renderer, ref } = render()
    deliverMessage(renderer, { type: 'web-ready' })
    deliverMessage(renderer, { type: 'ready', source: 'init' })

    act(() => {
      ref.current?.prepareForForegroundRecovery()
    })
    const pingId = JSON.parse(mocks.postMessage.mock.calls.at(-1)?.[0] as string).id as number
    deliverMessage(renderer, { type: 'pong', pingId })

    // Why: resize() notifies 'ready' synchronously, so a queued resize flushed by the pong
    // answers before the re-init repaint — accepting it would reveal the blank surface.
    deliverMessage(renderer, { type: 'ready', source: 'resize' })
    expect(webViewIsHidden(renderer)).toBe(true)

    deliverMessage(renderer, { type: 'ready', source: 'init' })
    expect(webViewIsHidden(renderer)).toBe(false)
  })

  it('pings for a lost init ready and reveals on the re-init that follows', () => {
    // Why: web-ready clears the readiness watchdog, so before this nothing watched for a
    // lost init 'ready' — the surface stayed hidden with no ping and no overlay.
    vi.useFakeTimers()
    const onWebReady = vi.fn()
    const onEngineError = vi.fn()
    const ref = { current: null as TerminalWebViewHandle | null }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(TerminalWebView, { ref, onWebReady, onEngineError } as never))
    })
    deliverMessage(renderer, { type: 'web-ready' })
    expect(onWebReady).toHaveBeenCalledTimes(1)
    act(() => {
      ref.current?.init(80, 24)
    })

    act(() => {
      vi.advanceTimersByTime(15000)
    })
    const pingId = lastPostedPingId()
    expect(onEngineError).not.toHaveBeenCalled()

    // Why: the probe pong must notify the parent — only its resubscribe re-inits, and only
    // an init 'ready' opens the gate. The pong itself proves nothing about paint.
    deliverMessage(renderer, { type: 'pong', pingId })
    expect(onWebReady).toHaveBeenCalledTimes(2)
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    deliverMessage(renderer, { type: 'ready', source: 'init' })
    expect(webViewIsHidden(renderer)).toBe(false)
    expect(onEngineError).not.toHaveBeenCalled()
  })

  it('surfaces the engine error when the lost-paint probe goes unanswered', () => {
    vi.useFakeTimers()
    const onEngineError = vi.fn()
    const ref = { current: null as TerminalWebViewHandle | null }
    act(() => {
      create(createElement(TerminalWebView, { ref, onEngineError } as never))
    })
    act(() => {
      ref.current?.init(80, 24)
    })

    act(() => {
      vi.advanceTimersByTime(15000)
    })
    expect(onEngineError).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    // Why: the document is web-ready, so only the painted surface can clear this probe.
    expect(onEngineError).toHaveBeenCalledWith(
      'Terminal did not paint - no init ready from the terminal view'
    )
  })

  it('does not judge paint once the init ready has arrived', () => {
    vi.useFakeTimers()
    const onEngineError = vi.fn()
    const ref = { current: null as TerminalWebViewHandle | null }
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(TerminalWebView, { ref, onEngineError } as never))
    })
    deliverMessage(renderer, { type: 'web-ready' })
    act(() => {
      ref.current?.init(80, 24)
    })
    deliverMessage(renderer, { type: 'ready', source: 'init' })

    mocks.postMessage.mockClear()
    act(() => {
      vi.advanceTimersByTime(60000)
    })
    expect(onEngineError).not.toHaveBeenCalled()
    expect(postedTypes()).not.toContain('ping')
    expect(webViewIsHidden(renderer)).toBe(false)
  })

  it('hides the surface when the content process terminates', () => {
    const { renderer } = render()
    deliverMessage(renderer, { type: 'web-ready' })
    deliverMessage(renderer, { type: 'ready', source: 'init' })
    expect(webViewIsHidden(renderer)).toBe(false)

    act(() => {
      findWebView(renderer).props.onContentProcessDidTerminate({ nativeEvent: {} })
    })
    // Why: the dead process leaves an invalid backing store on screen until onLoadStart.
    expect(webViewIsHidden(renderer)).toBe(true)
    expect(mocks.reload).toHaveBeenCalledTimes(1)
  })

  function postedTypes(): string[] {
    return mocks.postMessage.mock.calls.map(
      (c) => (JSON.parse(c[0] as string) as { type: string }).type
    )
  }

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

  it('hides a surface the fallback reload is about to discard', () => {
    // Why: an init 'ready' can land while readiness is still invalid (recovery ping
    // unanswered), leaving the surface visible when the probe later gives up. reload()
    // blanks the backing store before onLoadStart can hide it.
    vi.useFakeTimers()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(TerminalWebView, {} as never))
    })
    deliverMessage(renderer, { type: 'ready', source: 'init' })
    expect(webViewIsHidden(renderer)).toBe(false)

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
    expect(webViewIsHidden(renderer)).toBe(true)
  })

  it('cancels an armed ping probe when the pane unmounts', () => {
    vi.useFakeTimers()
    const onEngineError = vi.fn()
    let renderer!: ReactTestRenderer
    act(() => {
      renderer = create(createElement(TerminalWebView, { onEngineError } as never))
    })
    act(() => {
      vi.advanceTimersByTime(15000)
    })
    expect(lastPostedPingId()).toBeGreaterThan(0)

    act(() => {
      renderer.unmount()
    })
    act(() => {
      vi.advanceTimersByTime(2500)
    })
    // Why: the give-up would report an engine error for a pane that no longer exists.
    expect(onEngineError).not.toHaveBeenCalled()
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
      deliverMessage(renderer, { type: 'ready', source: 'init' })
      act(() => {
        ref.current?.prepareForForegroundRecovery()
      })
      expect(webViewIsHidden(renderer)).toBe(false)
    } finally {
      mocks.platformOS.value = 'ios'
    }
  })
})
