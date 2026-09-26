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

const CELL_1X = { fontScale: 1, cellWidth: 23 / 3, cellHeight: 17 }
const CELL_125X = { fontScale: 1.25, cellWidth: 29 / 3, cellHeight: 21 }

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  nativeWebViewMethods.postMessage.mockClear()
})

function mount(textScale = 1) {
  const ref = createRef<TerminalWebViewHandle>()
  const onCellBoxChange = vi.fn()
  act(() => {
    renderer = create(createElement(TerminalWebView, { ref, textScale, onCellBoxChange }))
  })
  const handle = () => {
    if (!ref.current) {
      throw new Error('no handle')
    }
    return ref.current
  }
  const notify = (payload: Record<string, unknown>) => {
    act(() => {
      renderer!.root
        .find((node) => typeof node.props.onMessage === 'function')
        .props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } })
    })
  }
  const rerender = (nextScale: number) => {
    act(() => {
      renderer!.update(
        createElement(TerminalWebView, { ref, textScale: nextScale, onCellBoxChange })
      )
    })
  }
  return { handle, notify, rerender, onCellBoxChange }
}

function postedTypes(): unknown[] {
  return nativeWebViewMethods.postMessage.mock.calls.map(([message]) => JSON.parse(message).type)
}

const WEB_READY = {
  type: 'web-ready',
  cellMetrics: [CELL_1X, CELL_125X],
  viewportWidth: 427,
  viewportHeight: 800
}

describe('terminal fit from the reported cell box', () => {
  it('answers from web-ready with no terminal and no measure message', async () => {
    const { handle, notify } = mount()
    notify(WEB_READY)
    expect(handle().fitDimensions(751)).toEqual({ cols: 55, rows: 44 })
    await expect(handle().measureFitDimensions(751)).resolves.toEqual({ cols: 55, rows: 44 })
    expect(postedTypes()).not.toContain('measure')
    expect(postedTypes()).not.toContain('init')
  })

  it('asks the document when an older one reports no cell box', async () => {
    const { handle, notify } = mount()
    notify({ type: 'web-ready' })
    expect(handle().fitDimensions(751)).toBeNull()
    const pending = handle().measureFitDimensions(751)
    expect(postedTypes()).toContain('measure')
    notify({ type: 'measure-result', cols: 55, rows: 44 })
    await expect(pending).resolves.toEqual({ cols: 55, rows: 44 })
  })

  it('follows a text-size change without a message', () => {
    const { handle, notify, rerender } = mount()
    notify(WEB_READY)
    rerender(1.25)
    expect(handle().fitDimensions(751)).toEqual({ cols: 44, rows: 35 })
    expect(postedTypes()).not.toContain('measure')
  })

  it('corrects a wrong guess from the laid-out box and tells the view the grid it has', () => {
    const { handle, notify, onCellBoxChange } = mount()
    notify(WEB_READY)
    const laidOut = { fontScale: 1, cellWidth: 7.8, cellHeight: 17 }
    notify({ type: 'cell-metrics', cellMetrics: [laidOut], cols: 55, rows: 44 })
    expect(handle().fitDimensions(751)).toEqual({ cols: 54, rows: 44 })
    expect(onCellBoxChange).toHaveBeenCalledExactlyOnceWith({ cols: 55, rows: 44 })
    notify({ type: 'cell-metrics', cellMetrics: [laidOut], cols: 54, rows: 44 })
    expect(onCellBoxChange).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the laid-out box matches the guess or is for another text size', () => {
    const { notify, onCellBoxChange } = mount()
    notify(WEB_READY)
    notify({ type: 'cell-metrics', cellMetrics: [CELL_1X], cols: 55, rows: 44 })
    const other = { fontScale: 1.25, cellWidth: 10, cellHeight: 21 }
    notify({ type: 'cell-metrics', cellMetrics: [other], cols: 55, rows: 44 })
    expect(onCellBoxChange).not.toHaveBeenCalled()
  })

  it('fits the view layout once it arrives', () => {
    const { handle, notify } = mount()
    notify(WEB_READY)
    act(() => {
      renderer!.root
        .find((node) => typeof node.props.onLayout === 'function')
        .props.onLayout({ nativeEvent: { layout: { width: 854, height: 400 } } })
    })
    expect(handle().fitDimensions()).toEqual({ cols: 111, rows: 23 })
  })
})
