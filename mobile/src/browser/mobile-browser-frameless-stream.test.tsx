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

// The seam ruling 5 put between the pane and a shell that may have no encoder behind the lane the
// pane would ask for. Native answers yes always; mocked here so both answers are reachable.
vi.mock('./use-browser-binary-screencast-grant', () => ({
  useBrowserBinaryScreencastGrant: vi.fn(() => true)
}))

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
  return renderer.root
    .findAllByType('Text')
    .flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []))
}

describe('MobileBrowserPane with a stream that reports ready but sends no frames', () => {
  // Why: a host that stops painting still reports `ready`, so the pane used to clear its
  // indicator and leave an unexplained black rectangle.
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
    const source = renderer.root
      .findAllByType('Image')
      .map((image) => (image.props.source as { uri?: string } | null)?.uri)
      .find((uri) => typeof uri === 'string')
    expect(source).toContain(Buffer.from(makeFrame().image).toString('base64'))
  })
})

describe('MobileBrowserPane against a shell with no binary screencast lane', () => {
  // Ruling 5: the grant is the negotiation. Subscribing anyway leaves the pane on a stream that
  // can never produce a frame, and the startup timeout is the only thing that would ever say so.
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

  it('subscribes when the shell names it, which is the control for the case above', async () => {
    const { renderer, subscriptions } = await renderPane()

    expect(subscriptions).toHaveLength(1)
    expect(errorMessages(renderer)).not.toContain(
      'Update the Orca app to stream browser tabs here.'
    )
  })
})
