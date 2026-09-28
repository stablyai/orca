import { createElement, createRef } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalWebView } from './TerminalWebView'
import type { TerminalWebViewHandle } from './terminal-webview-contract'

const nativeWebViewMethods = vi.hoisted(() => ({
  postMessage: vi.fn<(message: string) => void>(),
  reload: vi.fn<() => void>()
}))

vi.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Platform: { OS: 'android' },
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

vi.mock('lucide-react-native', () => ({ RefreshCw: 'RefreshCw' }))

const FRAME = { width: 427, height: 710 }
const scale = 1
const cellAt = (fontScale: number, cellWidth = 23 / 3) => ({ fontScale, cellWidth, cellHeight: 15 })

const renderers: ReactTestRenderer[] = []
afterEach(() => {
  act(() => renderers.splice(0).forEach((renderer) => renderer.unmount()))
  nativeWebViewMethods.postMessage.mockClear()
  nativeWebViewMethods.reload.mockClear()
  vi.useRealTimers()
})

function mount(textScale = scale) {
  const ref = createRef<TerminalWebViewHandle>()
  const onCellBoxChange = vi.fn()
  const onWebReady = vi.fn<() => void>()
  let renderer: ReactTestRenderer | undefined
  act(() => {
    renderer = create(
      createElement(TerminalWebView, { ref, textScale, onCellBoxChange, onWebReady })
    )
  })
  renderers.push(renderer!)
  const handle = () => {
    if (!ref.current) {
      throw new Error('no handle')
    }
    return ref.current
  }
  const webView = () => renderer!.root.find((node) => typeof node.props.onMessage === 'function')
  const notify = (payload: Record<string, unknown>) => {
    act(() => {
      webView().props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })
    })
  }
  return { handle, notify, onCellBoxChange, onWebReady, webView }
}

function postedTypes(): unknown[] {
  return nativeWebViewMethods.postMessage.mock.calls.map(([message]) => JSON.parse(message).type)
}

const cellBoxNotify = (cellWidth: number, refit: boolean) => ({
  type: 'cell-box',
  cellBox: cellAt(scale, cellWidth),
  refit
})

describe('the cell box xterm laid out', () => {
  it('sizes a fit from web-ready, which the document sends once its terminal is built', () => {
    const { handle, notify } = mount()
    expect(handle().fitDimensions(FRAME)).toBeNull()
    notify({ type: 'web-ready', cellBox: cellAt(scale) })
    expect(handle().fitDimensions(FRAME)).toEqual({ cols: 55, rows: 47 })
    expect(postedTypes()).not.toContain('measure')
  })

  it('fits each box the document reports, and refits only when the document says so', () => {
    // The document holds the grid and decides; its tests pin the one-refit bound.
    const { handle, notify, onCellBoxChange } = mount()
    notify({ type: 'web-ready', cellBox: cellAt(scale) })
    notify(cellBoxNotify(7.9, false))
    expect(onCellBoxChange).not.toHaveBeenCalled()
    expect(handle().fitDimensions(FRAME)).toEqual({ cols: 54, rows: 47 })
    notify(cellBoxNotify(7.8, true))
    expect(onCellBoxChange).toHaveBeenCalledTimes(1)
    expect(handle().fitDimensions(FRAME)).toEqual({ cols: 54, rows: 47 })
  })

  it('fits from the box the current document reported, not one an earlier document did', () => {
    const { handle, notify, webView } = mount()
    notify({ type: 'web-ready', cellBox: cellAt(scale) })
    act(() => webView().props.onLoadStart())
    notify({ type: 'web-ready', cellBox: null })
    expect(handle().fitDimensions(FRAME)).toBeNull()
  })

  it("fits only from a ready box at the app's text scale", () => {
    const { handle, notify, webView } = mount(1.5)
    // A document built at mount keeps that scale; a reload after a text-size change reports it.
    notify({ type: 'web-ready', cellBox: cellAt(1) })
    expect(handle().fitDimensions(FRAME)).toBeNull()
    act(() => webView().props.onLoadStart())
    notify({ type: 'web-ready', cellBox: cellAt(1.5) })
    expect(handle().fitDimensions(FRAME)).toEqual({ cols: 55, rows: 47 })
  })

  it('fits in the app from the reported box, and sends the frame with every grid', () => {
    const { handle, notify } = mount()
    notify({ type: 'web-ready', cellBox: cellAt(scale) })
    expect(handle().fitDimensions({ width: 427.5, height: 0 })).toBeNull()
    expect(handle().fitDimensions({ width: 427.5, height: 710 })).toEqual({ cols: 55, rows: 47 })
    const frame = { width: 427.5, height: 710 }
    handle().init({ cols: 55, rows: 47, initialData: '', frame })
    handle().resize(55, 47, frame)
    handle().reflow(55, 47, frame)
    const grids = nativeWebViewMethods.postMessage.mock.calls
      .map(([message]) => JSON.parse(message))
      .filter((message) => ['init', 'resize', 'reflow'].includes(message.type))
    expect(grids.map((message) => message.frame)).toEqual([frame, frame, frame])
    expect(postedTypes()).not.toContain('measure')
  })

  it('sends nothing before a ready: a load start drops what was queued', () => {
    const { handle, notify, webView } = mount()
    handle().init({ cols: 55, rows: 47, initialData: 'snapshot', frame: null })
    expect(postedTypes()).toEqual([])
    act(() => webView().props.onLoadStart())
    notify({ type: 'web-ready', cellBox: cellAt(scale) })
    expect(postedTypes()).not.toContain('init')
  })

  it('reloads the same view when its content process ends', () => {
    const { webView } = mount()
    const view = webView()
    act(() => view.props.onContentProcessDidTerminate({ nativeEvent: {} }))
    expect(nativeWebViewMethods.reload).toHaveBeenCalledTimes(1)
    expect(webView()).toBe(view)
  })

  it('drops queued and coalesced commands on a reload or a lost content process', () => {
    vi.useFakeTimers()
    const { handle, notify, webView } = mount()
    act(() => webView().props.onLoadStart())
    handle().write('for the reloaded document')
    act(() => webView().props.onLoadStart())
    handle().write('for the lost content process')
    act(() => webView().props.onContentProcessDidTerminate({ nativeEvent: {} }))
    notify({ type: 'web-ready', cellBox: cellAt(scale) })
    act(() => {
      vi.runAllTimers()
    })
    expect(postedTypes()).not.toContain('write')
    handle().write('for the current document')
    act(() => {
      vi.runAllTimers()
    })
    expect(postedTypes()).toContain('write')
  })

  it('tells the document the app text scale before it builds its terminal', () => {
    const { webView } = mount(1.25)
    const html: string = webView().props.source.html
    const start = html.indexOf('window.__orcaTerminalTextScale = 1.25;')
    expect(start).toBeGreaterThan(-1)
    // Ahead of the document script, in the page itself, so no platform can run it late.
    expect(start).toBeLessThan(html.indexOf('startTerminalDocument'))
  })

  it('keeps the source it mounted with across renders, so a new text scale does not reload', () => {
    const { webView } = mount(1)
    const source = webView().props.source
    act(() => renderers[0]!.update(createElement(TerminalWebView, { textScale: 1.5 })))
    expect(webView().props.source).toBe(source)
  })

  it('tells a document whose view was hidden at mount not to build before ready', () => {
    let renderer: ReactTestRenderer | undefined
    act(() => {
      renderer = create(createElement(TerminalWebView, { shownAtMount: false }))
    })
    renderers.push(renderer!)
    const webView = renderer!.root.find((node) => typeof node.props.onMessage === 'function')
    expect(webView.props.source.html).toContain('window.__orcaTerminalShown = false;')
  })
})
