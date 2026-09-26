/**
 * The pane's two frame layers as native shows them: a source or opacity is whatever was written
 * last, whether by a render or by `setNativeProps`, so a render that re-sends a stale prop is seen.
 */
import { createElement, type ReactElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'
import { MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS } from './browser-screencast-request'
import { MobileBrowserPane, type MobileBrowserTab } from './MobileBrowserPane'

vi.mock('./use-browser-binary-screencast-grant', () => ({
  useBrowserBinaryScreencastGrant: vi.fn(() => true)
}))

const appState = vi.hoisted(() => {
  const holder: { listener: ((state: string) => void) | null } = { listener: null }
  return holder
})

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: {
    currentState: 'active',
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listener = listener
      return { remove: () => {} }
    }
  },
  Image: 'Image',
  PanResponder: { create: () => ({ panHandlers: {} }) },
  PixelRatio: { get: () => 2 },
  Platform: { OS: 'android' },
  Pressable: 'Pressable',
  StyleSheet: {
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    create: (styles: unknown) => styles
  },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))

vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Monitor: 'Monitor',
  RefreshCw: 'RefreshCw',
  Smartphone: 'Smartphone'
}))

/**
 * One layer's native state, and the last value a render sent for each prop it models. A source
 * write that changes nothing loads nothing, as on Android and iOS; one that changes it owes one
 * answer, which reports the layer's current source, as Android's does.
 *
 * Keyed by the layer's `onLoad`, which is stable per layer: react-test-renderer builds a fresh mock
 * on every ref read, so the mock itself cannot hold state.
 */
type NativeLayer = {
  source: string | undefined
  loading: boolean
  opacity: number
  rendered: { source?: string; opacity?: number }
}
type NativeProps = { source?: { uri: string }[]; style?: { opacity?: number } }
const nativeLayers = new Map<unknown, NativeLayer>()

function nativeLayer(onLoad: unknown): NativeLayer {
  const existing = nativeLayers.get(onLoad)
  if (existing) {
    return existing
  }
  const created: NativeLayer = { source: undefined, loading: false, opacity: 1, rendered: {} }
  nativeLayers.set(onLoad, created)
  return created
}

function propOf(props: unknown, name: string): unknown {
  return props && typeof props === 'object' && name in props
    ? Object.getOwnPropertyDescriptor(props, name)?.value
    : undefined
}

/** The `onLoad` of the frame `<Image>` an element is, or is the layer `<View>` around. */
function layerKeyOf(element: ReactElement): unknown {
  if (element.type === 'Image') {
    return propOf(element.props, 'onLoad')
  }
  return propOf(propOf(propOf(element.props, 'children'), 'props'), 'onLoad')
}

/** Called once per host mount, for its ref: a fresh Image loads the source it mounted with. */
function createNodeMock(element: ReactElement) {
  const key = layerKeyOf(element)
  if (key !== undefined) {
    const layer = nativeLayer(key)
    if (element.type === 'Image') {
      const uri = propOf(propOf(element.props, 'source'), 'uri')
      layer.source = typeof uri === 'string' ? uri : undefined
      layer.loading = layer.source !== undefined
      layer.rendered.source = layer.source
    } else {
      layer.opacity = flatOpacity(propOf(element.props, 'style')) ?? 1
      layer.rendered.opacity = layer.opacity
    }
  }
  return {
    setNativeProps: (props: NativeProps) => {
      if (key === undefined) {
        return
      }
      const layer = nativeLayer(key)
      if (props.source?.[0]) {
        setSource(layer, props.source[0].uri)
      }
      if (props.style?.opacity !== undefined) {
        layer.opacity = props.style.opacity
      }
    }
  }
}

function setSource(layer: NativeLayer, source: string | undefined): void {
  if (source !== layer.source) {
    layer.source = source
    layer.loading = source !== undefined
  }
}

function flatOpacity(style: unknown): number | undefined {
  if (Array.isArray(style)) {
    return style.reduce<number | undefined>(
      (found, entry) => flatOpacity(entry) ?? found,
      undefined
    )
  }
  if (style && typeof style === 'object' && 'opacity' in style) {
    return typeof style.opacity === 'number' ? style.opacity : undefined
  }
  return undefined
}

function hostNodes(renderer: ReactTestRenderer, type: string): ReactTestInstance[] {
  return renderer.root.findAll((node) => node.type === type)
}

function frameImages(renderer: ReactTestRenderer): ReactTestInstance[] {
  return hostNodes(renderer, 'Image')
}

/** Applies what the last commit sent: a prop reaches native only when it differs from the last render's. */
function commitRenderedProps(renderer: ReactTestRenderer): void {
  for (const image of frameImages(renderer)) {
    const layer = nativeLayer(image.props.onLoad)
    const uri = propOf(image.props.source, 'uri')
    const source = typeof uri === 'string' ? uri : undefined
    if (source !== layer.rendered.source) {
      layer.rendered.source = source
      setSource(layer, source)
    }
    const opacity = flatOpacity(image.parent?.props.style) ?? 1
    if (opacity !== layer.rendered.opacity) {
      layer.rendered.opacity = opacity
      layer.opacity = opacity
    }
  }
}

function frame(seq: number, bytes: number[]): BrowserScreencastFrame {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq,
    format: 'jpeg',
    metadata: { deviceWidth: 360, deviceHeight: 640, pageScaleFactor: 1 },
    image: new Uint8Array(bytes)
  }
}

const uriOf = (next: BrowserScreencastFrame): string =>
  `data:image/jpeg;base64,${Buffer.from(next.image).toString('base64')}`

const CARET_ON = frame(1, [1, 1, 1])
const CARET_OFF = frame(2, [2, 2, 2])

let pageCounter = 0

async function renderPane() {
  pageCounter += 1
  const frames: { push: ((frame: BrowserScreencastFrame) => void) | null } = { push: null }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane only subscribes here; no request is sent in these cases.
  const client = {
    subscribe: (
      _method: string,
      _params: unknown,
      _listener: unknown,
      options?: { onBinaryFrame?: (frame: BrowserScreencastFrame) => void }
    ) => {
      frames.push = options?.onBinaryFrame ?? null
      return () => {}
    },
    request: vi.fn()
  } as unknown as RpcClient
  const tab: MobileBrowserTab = {
    type: 'browser',
    id: `tab-${pageCounter}`,
    title: 'Caret',
    browserWorkspaceId: 'bw-1',
    browserPageId: `page-${pageCounter}`,
    url: 'https://caret.example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: true
  }
  let renderer: ReactTestRenderer | null = null
  await act(async () => {
    renderer = create(
      createElement(MobileBrowserPane, {
        client,
        worktreeId: `wt-layers-${pageCounter}`,
        tab,
        screencastSupported: true,
        keyboardLift: 0,
        bottomInset: 0,
        onToast: () => {}
      }),
      { createNodeMock }
    )
    await Promise.resolve()
  })
  if (renderer === null) {
    throw new Error('nothing mounted')
  }
  const mounted: ReactTestRenderer = renderer
  const viewport = hostNodes(mounted, 'View').find(
    (node) => typeof node.props.onLayout === 'function'
  )
  act(() => {
    viewport?.props.onLayout({ nativeEvent: { layout: { width: 360, height: 640 } } })
  })

  const shown = (): string | undefined => {
    const visible = frameImages(mounted)
      .map((image) => nativeLayer(image.props.onLoad))
      .filter((layer) => layer.opacity === 1)
    expect(visible).toHaveLength(1)
    return visible[0]?.source
  }
  const push = (next: BrowserScreencastFrame): void => {
    act(() => {
      vi.advanceTimersByTime(MOBILE_BROWSER_FRAME_MIN_INTERVAL_MS)
      frames.push?.(next)
    })
    commitRenderedProps(mounted)
  }
  /** Native answers every load still owed, with a load or, for `failing`, an error. */
  const decodeAll = (failing?: BrowserScreencastFrame): void => {
    for (const image of frameImages(mounted)) {
      const layer = nativeLayer(image.props.onLoad)
      if (!layer.loading) {
        continue
      }
      layer.loading = false
      const uri = layer.source
      act(() => {
        if (failing && uri === uriOf(failing)) {
          image.props.onError?.({ nativeEvent: { error: 'decode failed' } })
        } else {
          image.props.onLoad?.({ nativeEvent: { source: { uri, width: 360, height: 640 } } })
        }
      })
    }
    commitRenderedProps(mounted)
  }
  const layout = (width: number, height: number): void => {
    act(() => {
      viewport?.props.onLayout({ nativeEvent: { layout: { width, height } } })
    })
    commitRenderedProps(mounted)
  }
  const setAppState = (state: string): void => {
    act(() => {
      appState.listener?.(state)
    })
    commitRenderedProps(mounted)
  }
  /** A render from state the frame path does not own, as a pinch or an address edit makes. */
  const rerender = (): void => {
    const address = hostNodes(mounted, 'TextInput')[0]
    act(() => {
      address?.props.onChangeText('https://caret.example/typed')
    })
    commitRenderedProps(mounted)
  }
  commitRenderedProps(mounted)
  return { decodeAll, layout, push, rerender, setAppState, shown }
}

describe('the pane frame layers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a blinking caret blinking across a render the frame path did not make', async () => {
    const pane = await renderPane()
    pane.push(CARET_ON)
    pane.decodeAll()
    pane.push(CARET_OFF)
    pane.decodeAll()
    expect(pane.shown()).toBe(uriOf(CARET_OFF))

    pane.rerender()
    expect(pane.shown()).toBe(uriOf(CARET_OFF))

    pane.push(CARET_ON)
    expect(pane.shown()).toBe(uriOf(CARET_ON))
    pane.push(CARET_OFF)
    expect(pane.shown()).toBe(uriOf(CARET_OFF))
  })

  it('shows a frame that was decoding when the app went to the background, sent again on return', async () => {
    const pane = await renderPane()
    pane.push(CARET_ON)
    pane.decodeAll()
    pane.push(CARET_OFF)

    pane.setAppState('background')
    pane.decodeAll()
    pane.setAppState('active')
    pane.push(CARET_OFF)
    pane.decodeAll()

    expect(pane.shown()).toBe(uriOf(CARET_OFF))
  })

  it('keeps streaming after a frame fails to decode and is sent again', async () => {
    const pane = await renderPane()
    pane.push(CARET_ON)
    pane.decodeAll()
    pane.push(CARET_OFF)
    pane.decodeAll(CARET_OFF)

    pane.push(CARET_OFF)
    pane.decodeAll()
    pane.push(CARET_ON)
    pane.decodeAll()
    const NEXT = frame(3, [3, 3, 3])
    pane.push(NEXT)
    pane.decodeAll()

    expect(pane.shown()).toBe(uriOf(NEXT))
  })

  it('keeps each layer and the stream through a remount of both Images mid-decode', async () => {
    const pane = await renderPane()
    pane.push(CARET_ON)
    pane.decodeAll()
    pane.push(CARET_OFF)
    pane.decodeAll()
    const NEXT = frame(3, [3, 3, 3])
    pane.push(NEXT)

    // A zero-size layout drops the frame geometry, which remounts both Images, and back again.
    pane.layout(0, 0)
    pane.layout(360, 640)
    pane.decodeAll()
    expect(pane.shown()).toBe(uriOf(CARET_OFF))

    const LAST = frame(4, [4, 4, 4])
    pane.push(LAST)
    pane.decodeAll()
    expect(pane.shown()).toBe(uriOf(LAST))
  })
})
