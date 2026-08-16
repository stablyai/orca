import { Buffer } from 'buffer'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  BrowserScreencastOpcode,
  type BrowserScreencastFrame
} from '../transport/browser-screencast-protocol'
import type { RpcClient } from '../transport/rpc-client'
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
}

let pageCounter = 0

function makeFrame(): BrowserScreencastFrame {
  return {
    opcode: BrowserScreencastOpcode.Frame,
    seq: 1,
    format: 'jpeg',
    metadata: { deviceWidth: 360, deviceHeight: 640, pageScaleFactor: 1 },
    image: new TextEncoder().encode('frame')
  }
}

function spinnerCount(renderer: ReactTestRenderer): number {
  return renderer.root.findAllByType('ActivityIndicator').length
}

async function renderPane(): Promise<{ renderer: ReactTestRenderer; stream: Subscription }> {
  pageCounter += 1
  const subscriptions: Subscription[] = []
  const client = {
    subscribe: (
      _method: string,
      _params: unknown,
      listener: (payload: unknown) => void,
      options?: { onBinaryFrame?: (frame: BrowserScreencastFrame) => void }
    ) => {
      subscriptions.push({ listener, onBinaryFrame: options?.onBinaryFrame })
      return () => {}
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
      createElement(MobileBrowserPane, {
        client,
        // Why: unique worktree id keeps each test on a cold module-level frame cache.
        worktreeId: `wt-${pageCounter}`,
        tab,
        screencastSupported: true,
        keyboardLift: 0,
        bottomInset: 0,
        onToast: () => {}
      }),
      { createNodeMock: () => ({ setNativeProps: () => {} }) }
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
  return { renderer: mounted, stream }
}

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
