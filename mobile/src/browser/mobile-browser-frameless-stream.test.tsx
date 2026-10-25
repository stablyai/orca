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
import { useBrowserBinaryScreencastGrant } from './use-browser-binary-screencast-grant'
import { findAllByHostType } from '../test-support/react-test-renderer-host-nodes'

// Mock binary-lane negotiation: native always supports it, but older shells may have no encoder behind requested lane (ruling 5).
vi.mock('./use-browser-binary-screencast-grant', () => ({
  useBrowserBinaryScreencastGrant: vi.fn(() => true)
}))

vi.mock('./MobileBrowserLoadProgress', () => ({ MobileBrowserLoadProgress: () => null }))

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

// Mock transitive icons too: Vitest throws on first unmocked export, including view-mode switch.
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
  return findAllByHostType(renderer.root, 'ActivityIndicator').length
}

async function renderPane(): Promise<{
  renderer: ReactTestRenderer
  stream: Subscription | undefined
  subscriptions: Subscription[]
}> {
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

  const rendered: { renderer?: ReactTestRenderer } = {}
  await act(async () => {
    rendered.renderer = create(
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
  const mounted = rendered.renderer
  if (!mounted) {
    throw new Error('MobileBrowserPane did not mount')
  }
  const viewport = findAllByHostType(mounted.root, 'View').find(
    (node) => typeof node.props.onLayout === 'function'
  )
  if (!viewport) {
    throw new Error('Viewport with onLayout not found')
  }
  act(() => {
    viewport.props.onLayout({ nativeEvent: { layout: { width: 360, height: 640 } } })
  })
  return { renderer: mounted, stream: subscriptions[0], subscriptions }
}

async function renderStreamingPane(): Promise<{
  renderer: ReactTestRenderer
  stream: Subscription
}> {
  const { renderer, stream } = await renderPane()
  if (!stream) {
    throw new Error('browser.screencast subscription not created')
  }
  return { renderer, stream }
}

function errorMessages(renderer: ReactTestRenderer): string[] {
  return findAllByHostType(renderer.root, 'Text').flatMap((node) =>
    typeof node.props.children === 'string' ? [node.props.children] : []
  )
}

describe('MobileBrowserPane with a stream that reports ready but sends no frames', () => {
  // Ready without frames must retain indicator instead of unexplained blank pane.
  it('keeps showing the loading indicator instead of an empty black pane', async () => {
    const { renderer, stream } = await renderStreamingPane()

    act(() => {
      stream.listener({ type: 'ready', tab: { url: 'https://dashboard.example' } })
    })

    expect(spinnerCount(renderer)).toBeGreaterThan(0)
  })

  it('clears the indicator once real pixels arrive', async () => {
    const { renderer, stream } = await renderStreamingPane()

    act(() => {
      stream.listener({ type: 'ready', tab: { url: 'https://dashboard.example' } })
    })
    act(() => {
      stream.onBinaryFrame?.(makeFrame())
    })

    expect(spinnerCount(renderer)).toBe(0)
    expect(errorMessages(renderer)).not.toContain(
      'Update the Orca app to stream browser tabs here.'
    )
    const source = findAllByHostType(renderer.root, 'Image')
      .map((image) => (image.props.source as { uri?: string } | null)?.uri)
      .find((uri) => typeof uri === 'string')
    expect(source).toContain(Buffer.from(makeFrame().image).toString('base64'))
  })
})

describe('MobileBrowserPane against a shell with no binary screencast lane', () => {
  // Grant is negotiation: subscribing without encoder yields no frames until startup timeout (ruling 5).
  it('never subscribes, and says so with the stream-error state it already has', async () => {
    vi.mocked(useBrowserBinaryScreencastGrant).mockReturnValue(false)
    try {
      const { renderer, subscriptions } = await renderPane()

      expect(subscriptions).toEqual([])
      expect(errorMessages(renderer)).toContain('Update the Orca app to stream browser tabs here.')
    } finally {
      vi.mocked(useBrowserBinaryScreencastGrant).mockReturnValue(true)
    }
  })
})
