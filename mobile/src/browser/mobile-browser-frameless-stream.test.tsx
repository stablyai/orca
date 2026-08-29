import { Buffer } from 'buffer'
import { createElement, Profiler } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { MobileBrowserPane, type MobileBrowserTab } from './MobileBrowserPane'

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
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

// Why: covers icons reached transitively too (the view-mode switch), not just the pane's own
// imports — vitest throws on the first unmocked export rather than rendering without it.
vi.mock('lucide-react-native', () => ({
  ArrowUp: 'ArrowUp',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  Monitor: 'Monitor',
  RefreshCw: 'RefreshCw',
  Smartphone: 'Smartphone'
}))

type Subscription = {
  listener: (payload: unknown) => void
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  active: boolean
}

type NativeMock = {
  id: number
  type: string
  frameLayer: boolean
  setNativeProps: ReturnType<typeof vi.fn>
}

type FrameLayer = {
  image: ReactTestInstance
  imageNative: NativeMock
  wrapperNative: NativeMock
}

let pageCounter = 0
let nativeCounter = 0

function makeFrame(contents = 'frame', seq = 1): BrowserScreencastFrame {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq,
    format: 'jpeg',
    metadata: { deviceWidth: 360, deviceHeight: 640, pageScaleFactor: 1 },
    image: new TextEncoder().encode(contents)
  }
}

function spinnerCount(renderer: ReactTestRenderer): number {
  return renderer.root.findAllByType('ActivityIndicator').length
}

function frameUri(contents: string): string {
  return `data:image/jpeg;base64,${Buffer.from(contents).toString('base64')}`
}

function getFrameLayers(
  renderer: ReactTestRenderer,
  nativeMocks: NativeMock[],
  useReplacementLayer = false
): [FrameLayer, FrameLayer] {
  const images = renderer.root.findAllByType('Image')
  const imageMocks = nativeMocks.filter(({ type }) => type === 'Image')
  const wrapperMocks = nativeMocks.filter(({ type, frameLayer }) => type === 'View' && frameLayer)
  const secondIndex = useReplacementLayer ? imageMocks.length - 1 : 1
  const secondWrapperIndex = useReplacementLayer ? wrapperMocks.length - 1 : 1
  if (images.length !== 2 || !imageMocks[0] || !imageMocks[secondIndex]) {
    throw new Error('Expected two native frame Image layers')
  }
  if (!wrapperMocks[0] || !wrapperMocks[secondWrapperIndex]) {
    throw new Error('Expected two native frame wrapper layers')
  }
  return [
    { image: images[0], imageNative: imageMocks[0], wrapperNative: wrapperMocks[0] },
    {
      image: images[1],
      imageNative: imageMocks[secondIndex],
      wrapperNative: wrapperMocks[secondWrapperIndex]
    }
  ]
}

function latestNativeImageUri(image: NativeMock): string | undefined {
  const lastCall = image.setNativeProps.mock.calls.at(-1)?.[0] as
    | { source?: { uri?: string }[] }
    | undefined
  return lastCall?.source?.[0]?.uri
}

async function renderPane(): Promise<{
  renderer: ReactTestRenderer
  stream: Subscription
  emitState: (state: ConnectionState) => void
  activeSubscriptionCount: () => number
  stateListenerCount: () => number
  renderCount: () => number
  nativeMocks: NativeMock[]
}> {
  pageCounter += 1
  const subscriptions: Subscription[] = []
  const stateListeners = new Set<(state: ConnectionState) => void>()
  const nativeMocks: NativeMock[] = []
  let commits = 0
  const client = {
    subscribe: (
      _method: string,
      _params: unknown,
      listener: (payload: unknown) => void,
      options?: { onBinaryFrame?: (frame: BrowserScreencastFrame) => void }
    ) => {
      const subscription = { listener, onBinaryFrame: options?.onBinaryFrame, active: true }
      subscriptions.push(subscription)
      return () => {
        subscription.active = false
      }
    },
    onStateChange: (listener: (state: ConnectionState) => void) => {
      stateListeners.add(listener)
      return () => stateListeners.delete(listener)
    },
    request: vi.fn()
  } as unknown as RpcClient

  const tab: MobileBrowserTab = {
    type: 'browser',
    id: `tab-${pageCounter}`,
    title: 'Dashboard',
    browserWorkspaceId: 'bw-1',
    browserPageId: `page-${pageCounter}`,
    url: 'https://dashboard.example',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    isActive: true
  }

  let renderer: ReactTestRenderer
  await act(async () => {
    renderer = create(
      createElement(
        Profiler,
        { id: 'mobile-browser-pane', onRender: () => (commits += 1) },
        createElement(MobileBrowserPane, {
          client,
          // Why: unique worktree id keeps each test on a cold module-level frame cache.
          worktreeId: `wt-${pageCounter}`,
          tab,
          screencastSupported: true,
          keyboardLift: 0,
          bottomInset: 0,
          onToast: () => {}
        })
      ),
      {
        createNodeMock: (element) => {
          const nativeMock = {
            id: ++nativeCounter,
            type: String(element.type),
            frameLayer: element.type === 'View' && element.props.pointerEvents === 'none',
            setNativeProps: vi.fn()
          }
          nativeMocks.push(nativeMock)
          return nativeMock
        }
      }
    )
    await Promise.resolve()
  })
  const mounted: ReactTestRenderer = renderer
  const viewport = mounted.root
    .findAllByType('View')
    .find((node) => typeof node.props.onLayout === 'function')
  if (!viewport) {
    throw new Error('Viewport with onLayout not found')
  }
  act(() => {
    viewport.props.onLayout({ nativeEvent: { layout: { width: 360, height: 640 } } })
  })
  const stream = subscriptions[0]
  if (!stream) {
    throw new Error('browser.screencast subscription not created')
  }
  return {
    renderer: mounted,
    stream,
    emitState: (state) => {
      for (const listener of stateListeners) {
        listener(state)
      }
    },
    activeSubscriptionCount: () => subscriptions.filter(({ active }) => active).length,
    stateListenerCount: () => stateListeners.size,
    renderCount: () => commits,
    nativeMocks
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('MobileBrowserPane with a stream that reports ready but sends no frames', () => {
  // Why: a host that stops painting still reports `ready`, so the pane used to clear its
  // indicator and leave an unexplained black rectangle.
  it('keeps showing the loading indicator instead of an empty black pane', async () => {
    const { renderer, stream } = await renderPane()

    act(() => {
      stream.listener({ type: 'ready', tab: { url: 'https://dashboard.example' } })
    })

    expect(spinnerCount(renderer)).toBeGreaterThan(0)
  })

  it('replaces only a pending decoder after reconnect and promotes the newest frame', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { renderer, stream, emitState, activeSubscriptionCount, nativeMocks } = await renderPane()

    act(() => {
      stream.onBinaryFrame?.(makeFrame('visible', 1))
    })
    const initialLayers = getFrameLayers(renderer, nativeMocks)

    act(() => {
      stream.onBinaryFrame?.(makeFrame('pending', 2))
      vi.advanceTimersByTime(100)
    })
    expect(latestNativeImageUri(initialLayers[1].imageNative)).toBe(frameUri('pending'))
    const staleLoad = initialLayers[1].image.props.onLoad as () => void
    const staleError = initialLayers[1].image.props.onError as () => void

    act(() => emitState('connected'))

    const reconnectedLayers = getFrameLayers(renderer, nativeMocks, true)
    expect(reconnectedLayers[0].imageNative).toBe(initialLayers[0].imageNative)
    expect(reconnectedLayers[0].wrapperNative).toBe(initialLayers[0].wrapperNative)
    expect(reconnectedLayers[1].imageNative).not.toBe(initialLayers[1].imageNative)
    expect(reconnectedLayers[1].wrapperNative).not.toBe(initialLayers[1].wrapperNative)
    expect(reconnectedLayers[0].image.props.source).toEqual({ uri: frameUri('visible') })
    expect(reconnectedLayers[1].image.props.source).toEqual({ uri: frameUri('pending') })
    expect(nativeMocks.filter(({ type }) => type === 'Image')).toHaveLength(3)
    expect(
      nativeMocks.filter(({ type, frameLayer }) => type === 'View' && frameLayer)
    ).toHaveLength(3)
    expect(activeSubscriptionCount()).toBe(1)

    for (const layer of reconnectedLayers) {
      layer.wrapperNative.setNativeProps.mockClear()
    }
    act(() => {
      staleLoad()
      staleError()
    })
    expect(reconnectedLayers[0].wrapperNative.setNativeProps).not.toHaveBeenCalled()
    expect(reconnectedLayers[1].wrapperNative.setNativeProps).not.toHaveBeenCalled()

    act(() => {
      stream.onBinaryFrame?.(makeFrame('newest', 3))
      vi.advanceTimersByTime(100)
    })
    expect(latestNativeImageUri(reconnectedLayers[1].imageNative)).toBe(frameUri('newest'))
    act(() => reconnectedLayers[1].image.props.onLoad())
    expect(reconnectedLayers[0].wrapperNative.setNativeProps).toHaveBeenLastCalledWith({
      style: { opacity: 0 }
    })
    expect(reconnectedLayers[1].wrapperNative.setNativeProps).toHaveBeenLastCalledWith({
      style: { opacity: 1 }
    })
    expect(activeSubscriptionCount()).toBe(1)
  })

  // Why: the load handler keys on (layer, decoderEpoch) and a B->C replacement reuses both,
  // so a late B onLoad does promote. Pin what that promotion actually lands on.
  it('promotes the newest frame when a superseded frame reports its load late', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const { renderer, stream, nativeMocks } = await renderPane()

    act(() => {
      stream.onBinaryFrame?.(makeFrame('visible', 1))
    })
    const layers = getFrameLayers(renderer, nativeMocks)

    act(() => {
      stream.onBinaryFrame?.(makeFrame('superseded', 2))
      vi.advanceTimersByTime(100)
    })
    expect(latestNativeImageUri(layers[1].imageNative)).toBe(frameUri('superseded'))

    // The final frame replaces the hidden layer's source without a new transition.
    act(() => {
      stream.onBinaryFrame?.(makeFrame('final', 3))
      vi.advanceTimersByTime(100)
    })
    expect(latestNativeImageUri(layers[1].imageNative)).toBe(frameUri('final'))

    for (const layer of layers) {
      layer.wrapperNative.setNativeProps.mockClear()
    }

    // The superseded frame's load arrives after its source was replaced.
    act(() => layers[1].image.props.onLoad())

    // The promoted layer is already pointed at the newest frame, not the superseded one,
    // and the layer it replaces held a strictly older frame.
    expect(latestNativeImageUri(layers[1].imageNative)).toBe(frameUri('final'))
    expect(layers[0].wrapperNative.setNativeProps).toHaveBeenLastCalledWith({
      style: { opacity: 0 }
    })
    expect(layers[1].wrapperNative.setNativeProps).toHaveBeenLastCalledWith({
      style: { opacity: 1 }
    })

    // The newest frame's own load is then a no-op: the transition is already settled.
    for (const layer of layers) {
      layer.wrapperNative.setNativeProps.mockClear()
    }
    act(() => layers[1].image.props.onLoad())
    expect(layers[0].wrapperNative.setNativeProps).not.toHaveBeenCalled()
    expect(layers[1].wrapperNative.setNativeProps).not.toHaveBeenCalled()
  })

  it('does no rendering or native work on a healthy connected boundary', async () => {
    const {
      renderer,
      stream,
      emitState,
      activeSubscriptionCount,
      stateListenerCount,
      renderCount,
      nativeMocks
    } = await renderPane()
    act(() => {
      stream.onBinaryFrame?.(makeFrame('visible'))
    })
    const layers = getFrameLayers(renderer, nativeMocks)
    const commitsBeforeReconnect = renderCount()
    for (const layer of layers) {
      layer.imageNative.setNativeProps.mockClear()
      layer.wrapperNative.setNativeProps.mockClear()
    }

    act(() => emitState('connected'))

    const layersAfterReconnect = getFrameLayers(renderer, nativeMocks)
    expect(renderCount()).toBe(commitsBeforeReconnect)
    expect(layersAfterReconnect.map(({ imageNative }) => imageNative)).toEqual(
      layers.map(({ imageNative }) => imageNative)
    )
    expect(layersAfterReconnect.map(({ wrapperNative }) => wrapperNative)).toEqual(
      layers.map(({ wrapperNative }) => wrapperNative)
    )
    expect(layers.flatMap(({ imageNative }) => imageNative.setNativeProps.mock.calls)).toEqual([])
    expect(layers.flatMap(({ wrapperNative }) => wrapperNative.setNativeProps.mock.calls)).toEqual(
      []
    )
    expect(activeSubscriptionCount()).toBe(1)
    expect(stateListenerCount()).toBe(1)

    act(() => renderer.unmount())
    expect(activeSubscriptionCount()).toBe(0)
    expect(stateListenerCount()).toBe(0)
  })

  it('clears the indicator once real pixels arrive', async () => {
    const { renderer, stream } = await renderPane()

    act(() => {
      stream.listener({ type: 'ready', tab: { url: 'https://dashboard.example' } })
    })
    act(() => {
      stream.onBinaryFrame?.(makeFrame())
    })

    expect(spinnerCount(renderer)).toBe(0)
    const source = renderer.root
      .findAllByType('Image')
      .map((image) => (image.props.source as { uri?: string } | null)?.uri)
      .find((uri) => typeof uri === 'string')
    expect(source).toContain(Buffer.from(makeFrame().image).toString('base64'))
  })
})
