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
    absoluteFill: { bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 },
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
  it('fits each box the document reports, and refits only when the document says so', () => {
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
    notify({ type: 'web-ready', cellBox: cellAt(1) })
    expect(handle().fitDimensions(FRAME)).toBeNull()
    act(() => webView().props.onLoadStart())
    notify({ type: 'web-ready', cellBox: cellAt(1.5) })
    expect(handle().fitDimensions(FRAME)).toEqual({ cols: 55, rows: 47 })
  })

  it('sends nothing before a ready: a load start drops what was queued', () => {
    const { handle, notify, webView } = mount()
    handle().init({ cols: 55, rows: 47, initialData: 'snapshot', frame: null })
    expect(postedTypes()).toEqual([])
    act(() => webView().props.onLoadStart())
    notify({ type: 'web-ready', cellBox: cellAt(scale) })
    expect(postedTypes()).not.toContain('init')
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
})
