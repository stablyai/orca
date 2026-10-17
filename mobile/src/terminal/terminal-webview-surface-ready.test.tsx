import { createElement, createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalWebView } from './TerminalWebView'
import type { TerminalWebViewHandle } from './terminal-webview-contract'
import { SURFACE_REVEAL_FALLBACK_MS } from './terminal-webview-document-lifecycle'
import { TerminalWebViewEngineErrorOverlay } from './terminal-webview-engine-error-state'
import { TERMINAL_WEBVIEW_FRAME_STYLES } from './terminal-webview-frame-styles'

const mocks = vi.hoisted(() => ({
  postMessage: vi.fn<(message: string) => void>(),
  reload: vi.fn<() => void>(),
  platformOS: { value: 'ios' }
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Platform: {
    get OS() {
      return mocks.platformOS.value
    }
  },
  Pressable: 'Pressable',
  StyleSheet: { absoluteFillObject: {}, create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))

vi.mock('react-native-webview', async () => {
  const React = await import('react')
  const WebView = React.forwardRef((props: Record<string, unknown>, ref) => {
    React.useImperativeHandle(ref, () => ({ postMessage: mocks.postMessage, reload: mocks.reload }))
    return React.createElement('WebView', props)
  })
  return { WebView, default: WebView }
})

vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))

const INIT = { cols: 80, rows: 24, frame: null }

// Why: mounting arms the web-ready watchdog; unmount so no timer outlives its test.
let activeRenderer: ReactTestRenderer | null = null

afterEach(() => {
  act(() => {
    activeRenderer?.unmount()
  })
  activeRenderer = null
  mocks.platformOS.value = 'ios'
  vi.clearAllMocks()
  vi.useRealTimers()
})

function render(props: Record<string, unknown> = {}) {
  const ref = createRef<TerminalWebViewHandle>()
  let renderer!: ReactTestRenderer
  act(() => {
    renderer = create(createElement(TerminalWebView, { ref, ...props }))
  })
  activeRenderer = renderer
  return { renderer, handle: () => ref.current! }
}

function webView(renderer: ReactTestRenderer) {
  return renderer.root.findByType('WebView' as never)
}

function surfaceHidden(renderer: ReactTestRenderer): boolean {
  const style: unknown = webView(renderer).props.style
  return Array.isArray(style) && style.includes(TERMINAL_WEBVIEW_FRAME_STYLES.webviewHidden)
}

function deliver(renderer: ReactTestRenderer, payload: Record<string, unknown>) {
  act(() => {
    webView(renderer).props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })
  })
}

function lastPingId(): number {
  const pings = mocks.postMessage.mock.calls
    .map(([message]) => JSON.parse(message) as { type: string; id: number })
    .filter((message) => message.type === 'ping')
  return pings.at(-1)!.id
}

function paintedTerminal() {
  const rendered = render()
  deliver(rendered.renderer, { type: 'web-ready' })
  act(() => rendered.handle().init(INIT))
  deliver(rendered.renderer, { type: 'ready', source: 'init' })
  expect(surfaceHidden(rendered.renderer)).toBe(false)
  return rendered
}

describe('TerminalWebView surface gate', () => {
  it('stays hidden through web-ready and reveals on the init ready', () => {
    const { renderer, handle } = render()
    expect(surfaceHidden(renderer)).toBe(true)

    // Why: web-ready proves the script runs, not that a frame committed.
    deliver(renderer, { type: 'web-ready' })
    act(() => handle().init(INIT))
    expect(surfaceHidden(renderer)).toBe(true)

    deliver(renderer, { type: 'ready', source: 'init' })
    expect(surfaceHidden(renderer)).toBe(false)
  })

  it("does not reveal on resize's ready, which answers before any repaint", () => {
    const { renderer, handle } = render()
    deliver(renderer, { type: 'web-ready' })
    act(() => handle().init(INIT))

    deliver(renderer, { type: 'ready', source: 'resize' })
    expect(surfaceHidden(renderer)).toBe(true)

    deliver(renderer, { type: 'ready', source: 'init' })
    expect(surfaceHidden(renderer)).toBe(false)
  })

  it("does not settle awaitReady on resize's ready", async () => {
    vi.useFakeTimers()
    const { renderer, handle } = render()
    deliver(renderer, { type: 'web-ready' })
    act(() => handle().init(INIT))
    let settled = false
    void handle()
      .awaitReady()
      .then(() => {
        settled = true
      })

    deliver(renderer, { type: 'ready', source: 'resize' })
    await act(async () => {
      await Promise.resolve()
    })
    expect(settled).toBe(false)

    deliver(renderer, { type: 'ready', source: 'init' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(settled).toBe(true)
  })

  it('hides again when a new document starts loading', () => {
    const { renderer } = paintedTerminal()
    act(() => {
      webView(renderer).props.onLoadStart()
    })
    expect(surfaceHidden(renderer)).toBe(true)
  })

  it('hides through iOS foreground recovery until the re-init has painted', () => {
    const { renderer, handle } = paintedTerminal()
    act(() => handle().prepareForForegroundRecovery())
    expect(surfaceHidden(renderer)).toBe(true)

    // Why: the pong restores messaging; only the re-init's ready proves a repaint.
    deliver(renderer, { type: 'pong', pingId: lastPingId() })
    expect(surfaceHidden(renderer)).toBe(true)

    act(() => handle().init(INIT))
    deliver(renderer, { type: 'ready', source: 'init' })
    expect(surfaceHidden(renderer)).toBe(false)
  })

  it('keeps the surface on a foreground recovery that does not ping', () => {
    mocks.platformOS.value = 'android'
    const { renderer, handle } = paintedTerminal()
    act(() => handle().prepareForForegroundRecovery())
    expect(surfaceHidden(renderer)).toBe(false)
  })

  it('hides before reloading after the content process ends', () => {
    const { renderer } = paintedTerminal()
    act(() => {
      webView(renderer).props.onContentProcessDidTerminate({ nativeEvent: {} })
    })
    expect(surfaceHidden(renderer)).toBe(true)
    expect(mocks.reload).toHaveBeenCalledTimes(1)
  })

  it("hides before the overlay's reload discards the backing store", () => {
    const { renderer } = paintedTerminal()
    deliver(renderer, { type: 'error', fatal: true, message: 'boom' })
    act(() => {
      renderer.root.findByType(TerminalWebViewEngineErrorOverlay).props.onReload()
    })
    expect(surfaceHidden(renderer)).toBe(true)
    expect(mocks.reload).toHaveBeenCalledTimes(1)
  })

  it('fails open when the init ready never arrives', () => {
    vi.useFakeTimers()
    const { renderer, handle } = render()
    deliver(renderer, { type: 'web-ready' })
    act(() => handle().init(INIT))

    act(() => {
      vi.advanceTimersByTime(SURFACE_REVEAL_FALLBACK_MS - 1)
    })
    expect(surfaceHidden(renderer)).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(surfaceHidden(renderer)).toBe(false)
  })

  it('does not reveal a pane that never inits, nor one replaced before its ready', () => {
    vi.useFakeTimers()
    const { renderer, handle } = render()
    deliver(renderer, { type: 'web-ready' })
    act(() => {
      vi.advanceTimersByTime(SURFACE_REVEAL_FALLBACK_MS * 4)
    })
    expect(surfaceHidden(renderer)).toBe(true)

    act(() => handle().init(INIT))
    act(() => {
      webView(renderer).props.onLoadStart()
    })
    act(() => {
      vi.advanceTimersByTime(SURFACE_REVEAL_FALLBACK_MS * 4)
    })
    expect(surfaceHidden(renderer)).toBe(true)
  })
})
